// Validation runner: re-analyze Saturday EPL matches using the ai-debate
// bridge instead of the Anthropic SDK. Anthropic API spend should be zero.
//
// Usage:
//   node worker/analyze-saturday.mjs
//
// Loads tokens from /Users/dw/Projects/toto-lab/functions/.env.
// Output: stdout summary + worker/saturday-analysis.json
//
// NO Firestore writes — pure validation. Push step is separate.

import { readFileSync, writeFileSync } from "node:fs";
import {
  getUpcomingMatches,
  getTeamRecentMatches,
  getTeamUpcomingFixtures,
  getHeadToHead,
  getStandings,
} from "../functions/footballData.js";
import { getEPLOdds, getEPLTeamTotals, findOddsForMatch } from "../functions/oddsApi.js";
import { devigMatchWinner, devigTwoWay } from "../functions/devig.js";

// ---- env loader (no dotenv dep) -------------------------------------------
const ENV_PATH = "/Users/dw/Projects/toto-lab/functions/.env";
for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const AI_DEBATE_URL = process.env.AI_DEBATE_URL || "http://localhost:3000";
const ARSENAL_TEAM_ID = 57;

// ---- ai-debate bridge -----------------------------------------------------
async function bridgeAnalyze({ systemPrompt, userPrompt, model = "claude-sonnet-4-6" }) {
  const res = await fetch(`${AI_DEBATE_URL}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ systemPrompt, userPrompt, model }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ai-debate ${res.status}: ${body}`);
  }
  return res.json(); // { data, usage }
}

// ---- injury fetcher via ai-debate (uses claude code's web_search tool) ----
async function fetchInjuries(teamName) {
  const systemPrompt = `You are a football injury data extractor. Use web_search to find current injury and suspension news for the given Premier League team. Only return players whose absence/doubt would meaningfully affect a match outcome (top scorers, key defenders, creative midfielders).`;
  const userPrompt = `Search the web for the most recent (last 7 days) injury and suspension status for "${teamName}" in the Premier League 2025-26 season. Use web_search.

Return ONLY this JSON shape (no prose, no fences):
{"out":["Player Name (reason)"],"doubtful":["Player Name (reason)"]}`;

  try {
    const { data, usage } = await bridgeAnalyze({ systemPrompt, userPrompt });
    return { data, tokens: usage };
  } catch (err) {
    console.error(`  [injuries] ${teamName} failed: ${err.message}`);
    return { data: { out: [], doubtful: [] }, tokens: null };
  }
}

// ---- analyzer prompt (mirrors functions/analyzer.js) ----------------------
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

// ---- fair edge helpers (mirror functions/index.js) ------------------------
function computeFairProbs(odds) {
  if (!odds) return null;
  const sharpMW = odds.fair?.matchWinner ?? odds.market?.matchWinner ?? odds.matchWinner ?? null;
  const sharpTotals = odds.fair?.totals?.best ?? odds.market?.totals?.best ?? odds.overUnder ?? null;
  const out = {};
  const mw = sharpMW ? devigMatchWinner(sharpMW, "power") : null;
  if (mw) out.matchWinner = mw;
  if (sharpTotals?.over && sharpTotals?.under) {
    const tw = devigTwoWay(sharpTotals.over, sharpTotals.under, "shin");
    if (tw) out.overUnder = { line: sharpTotals.line, over: tw[0], under: tw[1] };
  }
  return Object.keys(out).length ? out : null;
}

function getProbForPick(p, prediction) {
  if (p === "home") return prediction.probs?.home;
  if (p === "draw") return prediction.probs?.draw;
  if (p === "away") return prediction.probs?.away;
  if (p === "over") return prediction.overUnder?.over;
  if (p === "under") return prediction.overUnder?.under;
  return null;
}
function getFairForPick(p, fp) {
  if (!fp) return null;
  if (p === "home") return fp.matchWinner?.home;
  if (p === "draw") return fp.matchWinner?.draw;
  if (p === "away") return fp.matchWinner?.away;
  if (p === "over") return fp.overUnder?.over;
  if (p === "under") return fp.overUnder?.under;
  return null;
}

// ---- target match filter --------------------------------------------------
// User-listed Saturday matches (Korean → official names contain these substrings)
const ALL_TARGETS = [
  ["Brentford", "West Ham"],
  ["Newcastle", "Brighton"],
  ["Wolverhampton", "Sunderland"],
  ["Arsenal", "Fulham"],
  ["Bournemouth", "Crystal Palace"],
  ["Manchester United", "Liverpool"],
  ["Aston Villa", "Tottenham"],
];

// Optional comma-separated filter via env: WORKER_ONLY="Bournemouth,Aston Villa"
// matches if either home or away includes one of the substrings.
const ONLY = (process.env.WORKER_ONLY || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const TARGETS =
  ONLY.length === 0
    ? ALL_TARGETS
    : ALL_TARGETS.filter(([h, a]) =>
        ONLY.some((needle) => h.includes(needle) || a.includes(needle))
      );

function matchesTarget(home, away) {
  return TARGETS.some(([h, a]) => home.includes(h) && away.includes(a));
}

// ---- main -----------------------------------------------------------------
async function main() {
  const today = new Date();
  const dateFrom = today.toISOString().split("T")[0];
  const weekLater = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  const dateTo = weekLater.toISOString().split("T")[0];

  console.log(`[fixtures] fetching EPL ${dateFrom} → ${dateTo}`);
  const allMatches = await getUpcomingMatches({ dateFrom, dateTo });
  const targets = allMatches.filter((m) =>
    matchesTarget(m.homeTeam.name, m.awayTeam.name)
  );
  console.log(`[fixtures] matched ${targets.length}/${TARGETS.length} target matches:`);
  for (const m of targets) {
    console.log(`  - ${m.homeTeam.name} vs ${m.awayTeam.name} @ ${m.utcDate}`);
  }
  if (!targets.length) {
    console.error("No target matches found in next 7 days. Aborting.");
    process.exit(1);
  }

  console.log("\n[odds] fetching EPL odds + team totals");
  const [oddsEvents, teamTotalsEvents, standings] = await Promise.all([
    getEPLOdds(),
    getEPLTeamTotals(),
    getStandings(),
  ]);

  const results = [];

  for (const m of targets) {
    const matchKey = `${m.homeTeam.name} vs ${m.awayTeam.name}`;
    console.log(`\n=== ${matchKey} ===`);

    console.log("  [data] fetching recent/upcoming/h2h...");
    const [homeRecent, awayRecent, homeUpcoming, awayUpcoming, h2h] = await Promise.all([
      getTeamRecentMatches(m.homeTeam.id, 5),
      getTeamRecentMatches(m.awayTeam.id, 5),
      getTeamUpcomingFixtures(m.homeTeam.id, 5),
      getTeamUpcomingFixtures(m.awayTeam.id, 5),
      getHeadToHead(m.id, 5),
    ]);

    const homeStanding = standings.find((s) => s.teamId === m.homeTeam.id);
    const awayStanding = standings.find((s) => s.teamId === m.awayTeam.id);
    const odds = findOddsForMatch(oddsEvents, m.homeTeam.name, m.awayTeam.name, teamTotalsEvents);
    const ouLine = odds?.overUnder?.line ?? 2.5;

    console.log(`  [injuries] fetching for ${m.homeTeam.name} via ai-debate...`);
    const homeInj = await fetchInjuries(m.homeTeam.name);
    console.log(`    OUT: ${(homeInj.data.out || []).join(", ") || "none"}`);
    console.log(`    DOUBTFUL: ${(homeInj.data.doubtful || []).join(", ") || "none"}`);

    console.log(`  [injuries] fetching for ${m.awayTeam.name} via ai-debate...`);
    const awayInj = await fetchInjuries(m.awayTeam.name);
    console.log(`    OUT: ${(awayInj.data.out || []).join(", ") || "none"}`);
    console.log(`    DOUBTFUL: ${(awayInj.data.doubtful || []).join(", ") || "none"}`);

    const kickoffDate = new Date(m.utcDate);
    const hoursToKickoff = Math.round((kickoffDate.getTime() - Date.now()) / 3600_000);

    const userPrompt = buildUserPrompt({
      home: m.homeTeam.name,
      away: m.awayTeam.name,
      kickoff: kickoffDate.toISOString(),
      hoursToKickoff,
      homeStanding,
      awayStanding,
      homeRecent,
      awayRecent,
      homeUpcoming,
      awayUpcoming,
      h2h,
      odds,
      homeInjuries: homeInj.data,
      awayInjuries: awayInj.data,
      isFanTeam: m.homeTeam.id === ARSENAL_TEAM_ID || m.awayTeam.id === ARSENAL_TEAM_ID,
    });

    console.log("  [analyze] calling ai-debate bridge for match analysis...");
    let prediction;
    try {
      const resp = await bridgeAnalyze({
        systemPrompt: buildSystemPrompt(ouLine),
        userPrompt,
      });
      prediction = resp.data;
      console.log(`    pick=${prediction.pick} conf=${prediction.confidence} edge=${prediction.edge}`);
    } catch (err) {
      console.error(`    FAILED: ${err.message}`);
      results.push({ match: matchKey, error: err.message });
      continue;
    }

    const fairProbs = computeFairProbs(odds);
    const pickProb = getProbForPick(prediction.pick, prediction);
    const fairProb = getFairForPick(prediction.pick, fairProbs);
    const edgeFair =
      pickProb != null && fairProb != null
        ? Math.round((pickProb - fairProb * 100) * 10) / 10
        : null;

    console.log(`    edgeFair=${edgeFair}%p (raw edge=${prediction.edge})`);

    results.push({
      match: matchKey,
      fixtureId: m.id,
      kickoff: m.utcDate,
      pick: prediction.pick,
      confidence: prediction.confidence,
      edgeRaw: prediction.edge,
      edgeFair,
      probs: prediction.probs,
      overUnder: prediction.overUnder,
      ouLine,
      reasoning: prediction.reasoning,
      injuries: { home: homeInj.data, away: awayInj.data },
      odds,
      fairProbs,
    });
  }

  const suffix = ONLY.length ? `-rerun-${ONLY.length}` : "";
  const outPath = `/Users/dw/Projects/toto-lab/.claude/worktrees/sharp-babbage-7e76d3/worker/saturday-analysis${suffix}.json`;
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n[done] saved ${results.length} analyses → ${outPath}`);

  console.log("\n========== SUMMARY ==========");
  for (const r of results) {
    if (r.error) {
      console.log(`❌ ${r.match} — ${r.error}`);
      continue;
    }
    const passes = r.confidence >= 50 && r.edgeFair != null && r.edgeFair >= 5;
    const flag = passes ? "✅ PICK" : "  skip";
    console.log(
      `${flag} ${r.match} | ${r.pick} | conf ${r.confidence} | edgeFair ${r.edgeFair}%p (raw ${r.edgeRaw})`
    );
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
