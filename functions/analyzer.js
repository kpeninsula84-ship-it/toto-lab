import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a soccer betting analyst for the English Premier League.

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
- 1X2 probabilities sum to 100. Over/Under 2.5 probabilities sum to 100.
- Recommend pick ONLY if Edge > 5.
- Confidence 0-100 (<40 = 'none', 60+ = strong signal).
- If fan_team is true, STRICTLY data-driven.

Reasoning array: 3-6 bullets. Include player status bucket if relevant (e.g., "Arsenal: Saka OUT (hamstring), Odegaard DOUBTFUL (knee)").

Output STRICT JSON per schema. No markdown.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    probs: {
      type: "object",
      properties: {
        home: { type: "integer" },
        draw: { type: "integer" },
        away: { type: "integer" },
      },
      required: ["home", "draw", "away"],
      additionalProperties: false,
    },
    overUnder25: {
      type: "object",
      properties: {
        over: { type: "integer" },
        under: { type: "integer" },
      },
      required: ["over", "under"],
      additionalProperties: false,
    },
    pick: {
      type: "string",
      enum: ["home", "draw", "away", "over25", "under25", "none"],
    },
    edge: { type: "integer" },
    confidence: { type: "integer" },
    reasoning: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["probs", "overUnder25", "pick", "edge", "confidence", "reasoning"],
  additionalProperties: false,
};

export async function analyzeMatch(data) {
  const userContent = buildUserPrompt(data);
  const params = {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
    output_config: {
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
  };

  const response = await client.messages.create(params);

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text response from Claude");

  const prediction = JSON.parse(textBlock.text);

  console.log(
    `[analyze] ${data.home} vs ${data.away} — tokens in=${response.usage.input_tokens} out=${response.usage.output_tokens}`
  );

  return {
    probs: prediction.probs,
    overUnder25: prediction.overUnder25,
    pick: prediction.pick === "none" ? null : prediction.pick,
    edge: prediction.edge,
    confidence: prediction.confidence,
    reasoning: prediction.reasoning,
    isFanTeam: data.isFanTeam || false,
    odds: data.odds || null,
    model: "claude-sonnet-4-6",
    tokens: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    },
  };
}

export async function fetchTeamInjuries(teamName) {
  const params = {
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 1 }],
    messages: [
      {
        role: "user",
        content: `Search "${teamName} injury news Premier League" and extract current injury and suspension status. Return ONLY this JSON (no markdown, no explanation):
{"out":["name (reason)"],"doubtful":["name (reason)"]}
Only include players important enough to affect match results.`,
      },
    ],
  };

  let response = await client.messages.create(params);
  const messages = [...params.messages];

  let resumes = 0;
  while (response.stop_reason === "pause_turn" && resumes < 3) {
    messages.push({ role: "assistant", content: response.content });
    response = await client.messages.create({ ...params, messages });
    resumes++;
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) return { out: [], doubtful: [] };

  try {
    return JSON.parse(textBlock.text);
  } catch {
    return { out: [], doubtful: [] };
  }
}

function buildUserPrompt(data) {
  const homeOut = (data.homeInjuries?.out || []).join(", ") || "none reported";
  const homeDoubtful = (data.homeInjuries?.doubtful || []).join(", ") || "none reported";
  const awayOut = (data.awayInjuries?.out || []).join(", ") || "none reported";
  const awayDoubtful = (data.awayInjuries?.doubtful || []).join(", ") || "none reported";

  return `Match: ${data.home} (home) vs ${data.away} (away)
Kickoff: ${data.kickoff}
Hours until kickoff: ${data.hoursToKickoff}
fan_team: ${data.isFanTeam ? "true — STAY OBJECTIVE" : "false"}

=== BOOKMAKER ODDS (${data.odds?.bookmaker || "none"}) ===
${JSON.stringify(data.odds)}

=== ${data.home} — CURRENT STANDING ===
${JSON.stringify(data.homeStanding)}

=== ${data.away} — CURRENT STANDING ===
${JSON.stringify(data.awayStanding)}

=== ${data.home} — INJURY STATUS ===
OUT: ${homeOut}
DOUBTFUL: ${homeDoubtful}

=== ${data.away} — INJURY STATUS ===
OUT: ${awayOut}
DOUBTFUL: ${awayDoubtful}

=== ${data.home} — LAST 5 MATCHES (all competitions) ===
${JSON.stringify(data.homeRecent)}

=== ${data.home} — NEXT 5 FIXTURES (rotation risk check) ===
${JSON.stringify(data.homeUpcoming)}

=== ${data.away} — LAST 5 MATCHES (all competitions) ===
${JSON.stringify(data.awayRecent)}

=== ${data.away} — NEXT 5 FIXTURES (rotation risk check) ===
${JSON.stringify(data.awayUpcoming)}

=== HEAD TO HEAD (last 5) ===
${JSON.stringify(data.h2h)}

Analyze per the mandatory checks. Return JSON per schema.`;
}
