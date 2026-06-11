// Match analyzer that invokes the Claude Code CLI directly in headless
// (-p) mode, authenticated with CLAUDE_CODE_OAUTH_TOKEN under the user's
// subscription — zero Anthropic API spend. Runs on GitHub Actions.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CALL_TIMEOUT_MS = 10 * 60 * 1000;

function runClaude({ prompt, tools }) {
  const args = [
    "-p",
    "--output-format", "json",
    "--model", MODEL,
    "--no-session-persistence",
    "--strict-mcp-config",
  ];
  if (tools && tools.length > 0) args.push("--allowedTools", tools.join(","));

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      // Neutral cwd so the CLI doesn't auto-discover this repo's CLAUDE.md
      // (project work rules would pollute the analysis context).
      cwd: tmpdir(),
      // claude is a .cmd shim on Windows; argv stays shell-safe because the
      // prompt goes through stdin and every arg is a plain token.
      shell: process.platform === "win32",
    });

    let out = "";
    let errBuf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude CLI timed out after ${CALL_TIMEOUT_MS / 1000}s`));
    }, CALL_TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errBuf += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude CLI exit ${code}: ${(errBuf || out).slice(0, 500)}`));
      }
      resolve(out);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`no JSON object in model output: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function claudeAnalyze({ systemPrompt, userPrompt, tools }) {
  // -p mode takes a single prompt; fold the system prompt into it.
  const prompt = `${systemPrompt}\n\n=====\n\n${userPrompt}`;
  const raw = await runClaude({ prompt, tools });
  const envelope = JSON.parse(raw); // { type, is_error, result, usage, ... }
  if (envelope.is_error) {
    throw new Error(`claude CLI error result: ${String(envelope.result).slice(0, 300)}`);
  }
  const data = extractJson(envelope.result ?? "");
  return { data, usage: envelope.usage ?? {} };
}

// EPL seasons run Aug–May: from July onwards we're preparing for the
// season starting that year, otherwise we're inside the season that
// started the previous year.
function currentSeasonLabel(now = new Date()) {
  const y = now.getFullYear();
  const startYear = now.getMonth() >= 6 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

export async function fetchTeamInjuries(teamName) {
  const systemPrompt = `You are a football injury data extractor. Use the WebSearch tool to find current injury and suspension news for the given Premier League team. Only return players whose absence/doubt would meaningfully affect a match outcome (top scorers, key defenders, creative midfielders).`;
  const userPrompt = `Search the web for the most recent (last 7 days) injury and suspension status for "${teamName}" in the Premier League ${currentSeasonLabel()} season.

Return ONLY this JSON shape (no prose, no fences):
{"out":["Player Name (reason)"],"doubtful":["Player Name (reason)"]}`;

  try {
    const { data, usage } = await claudeAnalyze({
      systemPrompt,
      userPrompt,
      tools: ["WebSearch"],
    });
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
reasoningKr: same bullets translated to Korean. Keep team names, player names, competition names, and numeric stats in English (e.g. "Arsenal: Saka OUT (hamstring)" → "Arsenal: Saka OUT (햄스트링)").

Output STRICT JSON matching this shape:
{
  "probs": {"home": int, "draw": int, "away": int},
  "overUnder": {"over": int, "under": int},
  "pick": "home|draw|away|over|under|none",
  "edge": int,
  "confidence": int,
  "reasoning": [string, ...],
  "reasoningKr": [string, ...]
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

// Same input/output shape as the old ai-debate-bridge version; tokens come
// from the CLI result envelope.
export async function analyzeMatch(data) {
  const ouLine = data.odds?.overUnder?.line ?? 2.5;
  const { data: prediction, usage } = await claudeAnalyze({
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
    reasoningKr: prediction.reasoningKr ?? prediction.reasoning,
    isFanTeam: data.isFanTeam || false,
    odds: data.odds || null,
    model: MODEL,
    backend: "claude-cli",
    tokens: {
      input: usage?.input_tokens ?? 0,
      output: usage?.output_tokens ?? 0,
    },
  };
}
