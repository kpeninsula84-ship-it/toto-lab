// Match analyzer using the ai-debate bridge instead of the Anthropic SDK.
// The bridge spawns Claude Code CLI under the user's subscription, so this
// path costs zero in API spend.
//
// Drop-in replacement for functions/analyzer.js's analyzeMatch() and
// fetchTeamInjuries(). Same input/output shape; the rest of the pipeline
// does not need to know which backend produced the analysis.

const AI_DEBATE_URL = process.env.AI_DEBATE_URL || "http://localhost:3000";
const MODEL = process.env.AI_DEBATE_MODEL || "claude-sonnet-4-6";

async function bridgeAnalyze({ systemPrompt, userPrompt }) {
  const res = await fetch(`${AI_DEBATE_URL}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ systemPrompt, userPrompt, model: MODEL }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ai-debate ${res.status}: ${body}`);
  }
  return res.json(); // { data, usage }
}

export async function fetchTeamInjuries(teamName) {
  const systemPrompt = `You are a football injury data extractor. Use web_search to find current injury and suspension news for the given Premier League team. Only return players whose absence/doubt would meaningfully affect a match outcome (top scorers, key defenders, creative midfielders).`;
  const userPrompt = `Search the web for the most recent (last 7 days) injury and suspension status for "${teamName}" in the Premier League 2025-26 season. Use web_search.

Return ONLY this JSON shape (no prose, no fences):
{"out":["Player Name (reason)"],"doubtful":["Player Name (reason)"]}`;

  try {
    const { data, usage } = await bridgeAnalyze({ systemPrompt, userPrompt });
    return { ...data, _tokens: usage };
  } catch (err) {
    console.error(`[injuries] ${teamName} failed: ${err.message}`);
    return { out: [], doubtful: [] };
  }
}

function buildSystemPrompt(ouLine) {
  return `You are a soccer betting analyst for the English Premier League.

⚠️ TIMING: This analysis runs ~12-36 hours before kickoff. Official STARTING LINEUPS are NOT yet available (announced 1h before match). DO NOT attempt to predict who starts.

=== INJURY & SUSPENSION DATA ===
Injury and suspension data is pre-fetched and provided in the prompt.
Use it directly — do NOT search for additional injury info.

Classify each key player into EXACTLY ONE bucket based on provided data:
- **OUT**: confirmed unavailable (long-term injury, suspension, ruled out)
- **DOUBTFUL**: fitness uncertain, could play or not
- **AVAILABLE**: expected to be in squad (don't assume starter)

Only flag players important enough to move probabilities (top scorers, key defenders, creative midfielders).

=== MANDATORY ANALYSIS CHECKS ===

1. **Recent match calendar (fatigue)**:
   - Days since each team's last match.
   - Recent CL/UEL/FA Cup/EFL Cup matches = midweek fatigue.
   - A team with Tuesday CL has less rest than one with Saturday PL.

2. **Upcoming fixtures (rotation risk)**:
   - Major match (CL/UEL knockout) within 3-5 days AFTER → likely rotation.
   - Title race vs mid-table teams prioritize differently.

3. **Form momentum**: last 5 results weighted more than season total. Separate home/away form.

4. **Head-to-head**: last 5 patterns (tight, high-scoring, venue dominance).

5. **Bookmaker odds**: implied = 100 / decimal_odds. Edge = your_prob - implied.

6. **Key player status**: assess IMPACT by position type, not just absence:
   - Striker/playmaker OUT → significant only if no quality backup exists in squad
   - Fullback OUT → check if versatile players (CB or MF) can cover adequately; if yes, reduce impact significantly
   - Explicitly reason: "X is OUT but Y can cover at LB — limited impact" or "X is OUT with no adequate backup — attack weakened"
   - Only apply probability penalty if backup quality is meaningfully lower than the starter

=== OUTPUT RULES ===
- 1X2 probabilities sum to 100. Over/Under ${ouLine} probabilities sum to 100.
- Recommend pick ONLY if Edge > 5.
- Confidence 0-100 (<40 = 'none', 60+ = strong signal).
- If fan_team is true, STRICTLY data-driven.

Reasoning array: 3-6 bullets. Include player status bucket if relevant (e.g., "Arsenal: Saka OUT (hamstring), Odegaard DOUBTFUL (knee)").

Output STRICT JSON matching this shape:
{
  "probs": {"home": int, "draw": int, "away": int},
  "overUnder": {"over": int, "under": int},
  "pick": "home|draw|away|over|under|none",
  "edge": int,
  "confidence": int,
  "reasoning": [string, ...]
}
No markdown, no extra prose.`;
}

function buildUserPrompt(d) {
  const homeOut = (d.homeInjuries?.out || []).join(", ") || "none reported";
  const homeDoubtful = (d.homeInjuries?.doubtful || []).join(", ") || "none reported";
  const awayOut = (d.awayInjuries?.out || []).join(", ") || "none reported";
  const awayDoubtful = (d.awayInjuries?.doubtful || []).join(", ") || "none reported";

  return `Match: ${d.home} (home) vs ${d.away} (away)
Kickoff: ${d.kickoff}
Hours until kickoff: ${d.hoursToKickoff}
fan_team: ${d.isFanTeam ? "true — STAY OBJECTIVE" : "false"}

=== BOOKMAKER ODDS ===
${JSON.stringify(d.odds)}

=== ${d.home} — CURRENT STANDING ===
${JSON.stringify(d.homeStanding)}

=== ${d.away} — CURRENT STANDING ===
${JSON.stringify(d.awayStanding)}

=== ${d.home} — INJURY STATUS ===
OUT: ${homeOut}
DOUBTFUL: ${homeDoubtful}

=== ${d.away} — INJURY STATUS ===
OUT: ${awayOut}
DOUBTFUL: ${awayDoubtful}

=== ${d.home} — LAST 5 MATCHES ===
${JSON.stringify(d.homeRecent)}

=== ${d.home} — NEXT 5 FIXTURES ===
${JSON.stringify(d.homeUpcoming)}

=== ${d.away} — LAST 5 MATCHES ===
${JSON.stringify(d.awayRecent)}

=== ${d.away} — NEXT 5 FIXTURES ===
${JSON.stringify(d.awayUpcoming)}

=== HEAD TO HEAD (last 5) ===
${JSON.stringify(d.h2h)}

Return JSON only.`;
}

// Drop-in for functions/analyzer.js's analyzeMatch().
// Same input/output shape; tokens come from the bridge usage payload.
export async function analyzeMatch(data) {
  const ouLine = data.odds?.overUnder?.line ?? 2.5;
  const { data: prediction, usage } = await bridgeAnalyze({
    systemPrompt: buildSystemPrompt(ouLine),
    userPrompt: buildUserPrompt(data),
  });

  console.log(
    `[analyze] ${data.home} vs ${data.away} — tokens in=${usage?.input_tokens ?? 0} out=${usage?.output_tokens ?? 0}`
  );

  return {
    probs: prediction.probs,
    overUnder: prediction.overUnder,
    ouLine,
    pick: prediction.pick === "none" ? null : prediction.pick,
    edge: prediction.edge,
    confidence: prediction.confidence,
    reasoning: prediction.reasoning,
    isFanTeam: data.isFanTeam || false,
    odds: data.odds || null,
    model: MODEL,
    backend: "ai-debate",
    tokens: {
      input: usage?.input_tokens ?? 0,
      output: usage?.output_tokens ?? 0,
    },
  };
}
