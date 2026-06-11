// Market-anchored match analyzer (engine v2).
//
// The model does NOT invent probabilities. It receives de-vigged fair
// probabilities from a sharp book as the baseline and returns small
// evidence-backed DELTAS; code zeroes protocol-violating deltas,
// re-centers 1X2 deltas to sum zero, enforces a draw floor, and keeps
// fractional probabilities for pick selection. Rationale: last season
// the free-form engine claimed 52% average probability on picks that
// hit 22% — and 11 of 18 1X2 losses were draws it never picked.
//
// Claude is invoked via the Claude Code CLI in headless (-p) mode,
// authenticated with CLAUDE_CODE_OAUTH_TOKEN under the user's
// subscription — zero Anthropic API spend. Runs on GitHub Actions.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CALL_TIMEOUT_MS = 10 * 60 * 1000;

// Delta limits (percentage points). MAX_MW_DELTA must stay above the
// pick EDGE_THRESHOLD in pipeline.js or no pick can ever qualify.
export const MAX_MW_DELTA = 7; // per 1X2 outcome
export const MAX_OU_DELTA = 6; // on the Over side (Under mirrors)
export const DRAW_FLOOR_SLACK = 2; // draw may end at most 2pp below market
const BIG_DELTA = 5; // |delta| >= BIG_DELTA demands strong evidence/confidence
export const ENSEMBLE_DISAGREE_PP = 3; // sample gap that triggers a tiebreak run

// ── Claude CLI transport ─────────────────────────────────────────────────────

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

// ── Injuries ─────────────────────────────────────────────────────────────────

export async function fetchTeamInjuries(teamName) {
  const systemPrompt = `You are a football injury data extractor. Use the WebSearch tool to find current injury and suspension news for the given Premier League team. Only return players whose absence/doubt would meaningfully affect a match outcome (top scorers, key defenders, creative midfielders). Always include HOW RECENT each report is — recency decides whether the betting market has already priced the news.`;
  const userPrompt = `Search the web for the most recent (last 7 days) injury and suspension status for "${teamName}" in the Premier League ${currentSeasonLabel()} season.

Return ONLY this JSON shape (no prose, no fences). Append the report age to every entry:
{"out":["Player Name (reason; reported N days ago)"],"doubtful":["Player Name (reason; reported N days ago)"]}`;

  try {
    const { data, usage } = await claudeAnalyze({
      systemPrompt,
      userPrompt,
      tools: ["WebSearch"],
    });
    return { ...data, _tokens: usage };
  } catch (err) {
    console.error(`[injuries] ${teamName} failed: ${err.message}`);
    // fetchFailed distinguishes "no injuries reported" from "we couldn't
    // look" — the prompt tells the model to treat the squad as unknown.
    return { out: [], doubtful: [], fetchFailed: true };
  }
}

// ── Market-anchored post-processing ─────────────────────────────────────────

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Round fractional percentages to integers summing to 100
// (largest-remainder method).
export function roundToHundred(obj) {
  const entries = Object.keys(obj).map((k) => ({
    k,
    floor: Math.floor(obj[k]),
    rem: obj[k] - Math.floor(obj[k]),
  }));
  let leftover = 100 - entries.reduce((a, e) => a + e.floor, 0);
  entries.sort((a, b) => b.rem - a.rem);
  const out = {};
  for (const e of entries) {
    out[e.k] = e.floor + (leftover > 0 ? 1 : 0);
    if (leftover > 0) leftover--;
  }
  return out;
}

// Protocol gate: out-of-range deltas are ZEROED (clamping would launder
// delta inflation into a max-impact pick), and the 1X2 deltas are
// re-centered to sum zero so renormalization can't dilute or amplify.
export function sanitizeDeltas(rawDeltas = {}) {
  const violations = [];
  const d = {};
  for (const k of ["home", "draw", "away", "over"]) {
    const v = Number(rawDeltas?.[k]);
    d[k] = Number.isFinite(v) ? v : 0;
  }
  for (const k of ["home", "draw", "away"]) {
    if (Math.abs(d[k]) > MAX_MW_DELTA) {
      violations.push(`deltas.${k}=${d[k]} exceeds ±${MAX_MW_DELTA} — zeroed`);
      d[k] = 0;
    }
  }
  if (Math.abs(d.over) > MAX_OU_DELTA) {
    violations.push(`deltas.over=${d.over} exceeds ±${MAX_OU_DELTA} — zeroed`);
    d.over = 0;
  }
  const resid = d.home + d.draw + d.away;
  if (Math.abs(resid) > 1e-9) {
    if (Math.abs(resid) > 3) {
      violations.push(`1X2 deltas sum to ${resid} (must be 0) — re-centered`);
    }
    const shift = resid / 3;
    for (const k of ["home", "draw", "away"]) {
      d[k] = clamp(d[k] - shift, -MAX_MW_DELTA, MAX_MW_DELTA);
    }
  }
  return { deltas: d, violations };
}

// fairProbs: { matchWinner?: {home,draw,away} fractions, overUnder?: {line,over,under} fractions }
// rawDeltas: model output, percentage points.
// Returns integer probs for display plus fractional *Exact variants for
// pick selection (integer rounding adds ±1pp noise right on the edge
// threshold).
export function applyMarketAnchoredDeltas(fairProbs, rawDeltas = {}) {
  const { deltas, violations } = sanitizeDeltas(rawDeltas);
  const out = {
    probs: null,
    probsExact: null,
    overUnder: null,
    overUnderExact: null,
    appliedDeltas: deltas,
    violations,
  };

  const mw = fairProbs?.matchWinner;
  if (mw?.home != null && mw?.draw != null && mw?.away != null) {
    const base = { home: mw.home * 100, draw: mw.draw * 100, away: mw.away * 100 };
    const adj = {
      home: Math.max(base.home + deltas.home, 2),
      draw: base.draw + deltas.draw,
      away: Math.max(base.away + deltas.away, 2),
    };
    // Draw guard: LLMs systematically underrate EPL draws (~25% base rate).
    const drawFloor = Math.max(base.draw - DRAW_FLOOR_SLACK, 2);
    adj.draw = Math.max(adj.draw, drawFloor);

    const scale = 100 / (adj.home + adj.draw + adj.away);
    for (const k of ["home", "draw", "away"]) adj[k] *= scale;

    // Scaling can push the draw back under its floor — re-assert it and
    // take the deficit from home/away proportionally.
    if (adj.draw < drawFloor) {
      const deficit = drawFloor - adj.draw;
      const ha = adj.home + adj.away;
      adj.draw = drawFloor;
      adj.home -= deficit * (adj.home / ha);
      adj.away -= deficit * (adj.away / ha);
    }

    out.probsExact = { home: adj.home, draw: adj.draw, away: adj.away };
    out.probs = roundToHundred(out.probsExact);
  }

  const ou = fairProbs?.overUnder;
  if (ou?.over != null && ou?.under != null) {
    const overExact = clamp(ou.over * 100 + deltas.over, 5, 95);
    out.overUnderExact = { over: overExact, under: 100 - overExact };
    const overInt = Math.round(overExact);
    out.overUnder = { over: overInt, under: 100 - overInt };
  }

  return out;
}

// Largest per-key gap between two delta samples — LLM sampling noise
// detector. A big gap means the evidence doesn't pin the answer down.
export function maxDeltaGap(a, b) {
  return Math.max(
    ...["home", "draw", "away", "over"].map((k) => Math.abs((a?.[k] ?? 0) - (b?.[k] ?? 0)))
  );
}

// Per-key median across delta samples (median of 2 = mean). Sum-zero is
// re-asserted later by sanitizeDeltas inside applyMarketAnchoredDeltas.
export function medianDeltas(samples) {
  const out = {};
  for (const k of ["home", "draw", "away", "over"]) {
    const vals = samples.map((s) => s?.[k] ?? 0).sort((x, y) => x - y);
    const mid = Math.floor(vals.length / 2);
    out[k] = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  }
  return out;
}

function validateV2(prediction) {
  if (!prediction || typeof prediction !== "object") {
    throw new Error("v2 output is not an object");
  }
  const d = prediction.deltas;
  if (!d || typeof d !== "object") {
    throw new Error("v2 output missing deltas");
  }
  for (const k of ["home", "draw", "away", "over"]) {
    if (d[k] != null && !Number.isFinite(Number(d[k]))) {
      throw new Error(`v2 delta "${k}" is not numeric: ${JSON.stringify(d[k])}`);
    }
  }
  const conf = Number(prediction.confidence);
  if (!Number.isFinite(conf) || conf < 0 || conf > 100) {
    throw new Error(`v2 confidence out of range: ${JSON.stringify(prediction.confidence)}`);
  }
  if (!Array.isArray(prediction.reasoning) || prediction.reasoning.length === 0) {
    throw new Error("v2 output missing reasoning");
  }
}

// ── Prompts ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(ouLine, fairSource) {
  return `You are a soccer betting analyst for the English Premier League.

⚠️ TIMING: This analysis runs ~12-36 hours before kickoff. Official STARTING LINEUPS are NOT yet available (announced 1h before match). DO NOT attempt to predict who starts.

=== YOUR TASK: ADJUST THE MARKET, DON'T REPLACE IT ===
You are given FAIR (de-vigged) probabilities from a sharp bookmaker (${fairSource ?? "market"}). Sharp EPL markets are highly efficient — table position, form, H2H, home advantage, and any team news older than ~72 hours are ALREADY in the price. Your only job is to judge whether the evidence below contains something the market may not have fully priced yet.

On a typical slate, MOST matches should return all-zero deltas. An all-zero output with confidence 0 is a complete, correct, and common answer — it means the market is right. You are graded on calibration, not on finding edges.

Output adjustments as DELTAS in percentage points:
- deltas.home / deltas.draw / deltas.away: integers, each in [-${MAX_MW_DELTA}, +${MAX_MW_DELTA}], and they MUST sum to exactly 0. Outputs that break range or sum are DISCARDED, not clamped — a delta of +20 achieves nothing.
- deltas.over: integer in [-${MAX_OU_DELTA}, +${MAX_OU_DELTA}] for the Over ${ouLine} side (Under mirrors automatically).
- |delta| >= ${BIG_DELTA} requires exceptional, specific, RECENT evidence (e.g. 3+ first-XI players ruled out within the last 48h) AND confidence >= 50 — a big delta with low confidence is self-contradictory and will be discarded.
- RECENCY RULE: news older than ~72h is priced. Only developments from roughly the last 24-48h can justify a delta.
- DRAW DISCIPLINE: EPL matches end in draws ~25% of the time and models habitually underrate them. When you downgrade the stronger team, route at least ~40% of that probability mass to the DRAW, not all to the opponent — unless keyFactors cites concrete evidence the match will be open. A negative deltas.draw always requires explicit justification in keyFactors.

=== INJURY & SUSPENSION DATA ===
Injury and suspension data is pre-fetched and provided in the prompt, with report age.
Use it directly — do NOT search for additional injury info.
If a team's injury section says DATA UNAVAILABLE, treat that squad's status as unknown: do NOT assume full strength, and avoid deltas that depend on that team's player availability.

Classify each key player into EXACTLY ONE bucket based on provided data:
- **OUT**: confirmed unavailable (long-term injury, suspension, ruled out)
- **DOUBTFUL**: fitness uncertain, could play or not
- **AVAILABLE**: expected to be in squad (don't assume starter)

Assess IMPACT by position and backup quality, not mere absence. A widely-known long-term absence is already in the market price — it NEVER justifies a delta by itself; only fresh changes do.

=== WHAT CAN LEGITIMATELY MOVE A DELTA ===
1. Fresh team news (last 24-48h): new injuries/suspensions/returns the market may still be digesting.
2. Schedule asymmetry: the computed SCHEDULE FACTS (rest days, congestion, big match within days after) — markets price these imperfectly.
3. Confirmed heavy rotation signals (manager statements, dead-rubber dynamics).
Standings, raw form, and H2H are PRICED — they may be cited only as supporting context for a delta caused by 1-3, never as its sole justification.

=== OUTPUT ===
confidence: 0-100 — strength of the EVIDENCE behind your deltas (0 = pure baseline / nothing notable, 60+ = strong specific evidence). It measures evidence quality, NOT delta size.
keyFactors: one short string per non-zero delta naming its evidence and recency.
reasoning: 3-6 bullets (EN), grounded in the data provided. Include player status buckets where relevant.
reasoningKr: same bullets in Korean. Keep team/player/competition names and numeric stats in English (e.g. "Arsenal: Saka OUT (햄스트링)").
If fan_team is true, STRICTLY data-driven.

Output STRICT JSON matching this shape:
{
  "deltas": {"home": int, "draw": int, "away": int, "over": int},
  "keyFactors": [string, ...],
  "confidence": int,
  "reasoning": [string, ...],
  "reasoningKr": [string, ...]
}
No markdown, no extra prose.`;
}

function fmtInjuries(inj) {
  if (inj?.fetchFailed) {
    return "DATA UNAVAILABLE (fetch failed — treat squad status as unknown)";
  }
  const out = (inj?.out || []).join(", ") || "none reported";
  const doubtful = (inj?.doubtful || []).join(", ") || "none reported";
  return `OUT: ${out}\nDOUBTFUL: ${doubtful}`;
}

function pct(f) {
  return `${(f * 100).toFixed(1)}%`;
}

function buildBaselineSection(d) {
  const lines = [`=== MARKET BASELINE — fair (de-vigged) probabilities (${d.fairSource ?? "market"}) ===`];
  const mw = d.fairProbs?.matchWinner;
  if (mw) lines.push(`1X2: home ${pct(mw.home)}, draw ${pct(mw.draw)}, away ${pct(mw.away)}`);
  const ou = d.fairProbs?.overUnder;
  if (ou) lines.push(`Over/Under ${ou.line}: over ${pct(ou.over)}, under ${pct(ou.under)}`);
  return lines.join("\n");
}

// The market prices full standings; position/points/form is enough context.
function slimStanding(s) {
  if (!s) return null;
  return { pos: s.pos, points: s.points, played: s.played, form: s.form };
}

// Rest, congestion, and what's next — the calendar is the part of "recent
// matches" the market prices imperfectly. Computed here so the model
// reasons over facts instead of re-deriving form from raw results.
export function scheduleFacts(recent = [], upcoming = [], kickoffIso) {
  const ko = new Date(kickoffIso).getTime();
  const DAY = 86_400_000;
  const played = recent
    .map((m) => new Date(m.date).getTime())
    .filter((t) => Number.isFinite(t) && t < ko);
  const lastT = played.length ? Math.max(...played) : null;
  const lastMatch =
    lastT != null ? recent.find((m) => new Date(m.date).getTime() === lastT) : null;
  const nexts = upcoming
    .map((m) => ({ t: new Date(m.date).getTime(), m }))
    .filter((x) => Number.isFinite(x.t) && x.t > ko + 3 * 3_600_000)
    .sort((a, b) => a.t - b.t);
  return {
    daysSinceLastMatch: lastT != null ? Math.round(((ko - lastT) / DAY) * 10) / 10 : null,
    lastMatchCompetition: lastMatch?.competition ?? null,
    matchesInLast14Days: played.filter((t) => ko - t <= 14 * DAY).length,
    daysToNextMatch: nexts.length ? Math.round(((nexts[0].t - ko) / DAY) * 10) / 10 : null,
    nextMatchCompetition: nexts.length ? (nexts[0].m.competition ?? null) : null,
  };
}

function buildUserPrompt(d) {
  const homeSchedule = scheduleFacts(d.homeRecent, d.homeUpcoming, d.kickoff);
  const awaySchedule = scheduleFacts(d.awayRecent, d.awayUpcoming, d.kickoff);

  return `Match: ${d.home} (home) vs ${d.away} (away)
Kickoff: ${d.kickoff}
Hours until kickoff: ${d.hoursToKickoff}
fan_team: ${d.isFanTeam ? "true — STAY OBJECTIVE" : "false"}

${buildBaselineSection(d)}

=== SCHEDULE FACTS (computed — rest, congestion, what's next) ===
${d.home}: ${JSON.stringify(homeSchedule)}
${d.away}: ${JSON.stringify(awaySchedule)}

=== ${d.home} — INJURY STATUS ===
${fmtInjuries(d.homeInjuries)}

=== ${d.away} — INJURY STATUS ===
${fmtInjuries(d.awayInjuries)}

=== STANDINGS (context only — already priced) ===
${d.home}: ${JSON.stringify(slimStanding(d.homeStanding))}
${d.away}: ${JSON.stringify(slimStanding(d.awayStanding))}

=== LAST 5 MATCHES (context only — already priced; use for calendar/rotation reading, not form re-pricing) ===
${d.home}: ${JSON.stringify(d.homeRecent)}
${d.away}: ${JSON.stringify(d.awayRecent)}

=== NEXT 5 FIXTURES (rotation pressure) ===
${d.home}: ${JSON.stringify(d.homeUpcoming)}
${d.away}: ${JSON.stringify(d.awayUpcoming)}

Return JSON only.`;
}

// ── Skeptic verification pass ────────────────────────────────────────────────

const SKEPTIC_SYSTEM_PROMPT = `You are a skeptical auditor at a sports betting desk. A junior analyst proposes probability adjustments (deltas, percentage points) against the de-vigged sharp-market baseline for an EPL match. Sharp books price public information within minutes; most proposed edges are mirages — last season, the desk's boldest market disagreements were its worst bets.

REFUTE the proposal unless ALL of the following hold:
1. The cited evidence is SPECIFIC — named players or events, not narratives ("momentum", "fatigue" without numbers, "they always struggle here").
2. It is RECENT — from roughly the last 24-48 hours (report ages are included in the injury data).
3. It is plausibly NOT YET FULLY PRICED — late-breaking, ambiguous, or under-reported.
Long-known absences, form, table position, H2H, and generic rotation talk are ALREADY priced — a proposal resting on them must be refuted.
Default to refute when uncertain.

Output STRICT JSON: {"verdict":"uphold"|"refute","confidence":int,"note":"one short sentence"}
confidence = your own 0-100 rating of the evidence strength if upheld (ignored on refute). No markdown, no extra prose.`;

function buildSkepticUserPrompt(data, deltas, keyFactors, reasoning) {
  return `Match: ${data.home} (home) vs ${data.away} (away)
Kickoff: ${data.kickoff} (in ${data.hoursToKickoff}h)

${buildBaselineSection(data)}

=== PROPOSED DELTAS (pp vs baseline) ===
${JSON.stringify(deltas)}

=== ANALYST'S CITED EVIDENCE ===
keyFactors: ${JSON.stringify(keyFactors)}
reasoning: ${JSON.stringify(reasoning)}

=== ${data.home} — INJURY DATA (with report ages) ===
${fmtInjuries(data.homeInjuries)}

=== ${data.away} — INJURY DATA (with report ages) ===
${fmtInjuries(data.awayInjuries)}

Audit the proposal. Return JSON only.`;
}

// Refute-by-default audit of non-zero deltas. Infrastructure errors keep
// the proposal (flagged) — the verifier exists to kill weak evidence,
// not to fail runs.
async function skepticVerify(data, deltas, keyFactors, reasoning) {
  try {
    const { data: verdict, usage } = await claudeAnalyze({
      systemPrompt: SKEPTIC_SYSTEM_PROMPT,
      userPrompt: buildSkepticUserPrompt(data, deltas, keyFactors, reasoning),
    });
    if (verdict?.verdict === "refute" || verdict?.verdict === "uphold") {
      return {
        verdict: verdict.verdict,
        note: typeof verdict.note === "string" ? verdict.note : null,
        confidence: Number.isFinite(Number(verdict.confidence)) ? Number(verdict.confidence) : null,
        usage,
      };
    }
    return { verdict: "uphold", note: "verifier returned malformed verdict — proposal kept", confidence: null, usage };
  } catch (err) {
    return { verdict: "uphold", note: `verifier error: ${err.message}`, confidence: null, error: true, usage: {} };
  }
}

// ── Main entry ───────────────────────────────────────────────────────────────

// data: match context assembled by pipeline.runFullAnalysis, including
// `fairProbs` (de-vigged baseline) and `fairSource`. Returns anchored
// probabilities; pick selection happens in pipeline.js against the same
// fair baseline.
export async function analyzeMatch(data) {
  const ouLine = data.fairProbs?.overUnder?.line ?? data.odds?.overUnder?.line ?? 2.5;

  if (!data.fairProbs) {
    // No odds posted yet → no baseline and no possible pick. Skip the model
    // call; the next run (closer to kickoff) will have odds.
    return {
      probs: null,
      probsExact: null,
      overUnder: null,
      overUnderExact: null,
      ouLine,
      confidence: null,
      deltas: null,
      deltasRaw: null,
      protocolViolations: [],
      keyFactors: [],
      reasoning: ["No bookmaker odds available yet — analysis deferred to the next run."],
      reasoningKr: ["아직 배당이 등록되지 않아 분석을 다음 실행으로 미룹니다."],
      isFanTeam: data.isFanTeam || false,
      odds: data.odds || null,
      model: MODEL,
      backend: "claude-cli",
      engine: "v2-market-anchored",
      skipped: "no_odds",
      tokens: { input: 0, output: 0 },
    };
  }

  const systemPrompt = buildSystemPrompt(ouLine, data.fairSource);
  const userPrompt = buildUserPrompt(data);
  const tokens = { input: 0, output: 0 };
  const addTokens = (usage) => {
    tokens.input += usage?.input_tokens ?? 0;
    tokens.output += usage?.output_tokens ?? 0;
  };

  const sampleOnce = async () => {
    const { data: prediction, usage } = await claudeAnalyze({ systemPrompt, userPrompt });
    validateV2(prediction);
    addTokens(usage);
    return prediction;
  };

  // Adaptive ensemble: two independent samples kill single-run sampling
  // noise; a gap > ENSEMBLE_DISAGREE_PP means the evidence doesn't pin
  // the answer down → one tiebreak sample, per-key median, and the
  // LOWEST sample confidence (instability is itself evidence weakness).
  const settled = await Promise.allSettled([sampleOnce(), sampleOnce()]);
  const predictions = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!predictions.length) {
    throw settled[0].reason;
  }

  const violations = [];
  let sampleDeltas = predictions.map((p) => sanitizeDeltas(p.deltas).deltas);
  let disagreement = null;
  let tiebreak = false;

  if (predictions.length === 2) {
    disagreement = Math.round(maxDeltaGap(sampleDeltas[0], sampleDeltas[1]) * 10) / 10;
    if (disagreement > ENSEMBLE_DISAGREE_PP) {
      tiebreak = true;
      try {
        const third = await sampleOnce();
        predictions.push(third);
        sampleDeltas.push(sanitizeDeltas(third.deltas).deltas);
      } catch (err) {
        violations.push(`tiebreak sample failed (${err.message}) — proceeding with 2 samples`);
      }
    }
  } else {
    violations.push("one ensemble sample failed validation — single-sample mode");
  }

  for (const p of predictions) {
    violations.push(...sanitizeDeltas(p.deltas).violations);
  }

  const consensusDeltas = medianDeltas(sampleDeltas);
  const confidences = predictions.map((p) => Math.round(Number(p.confidence)));
  const confidence = tiebreak
    ? Math.min(...confidences)
    : Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length);

  // Representative narrative: the sample whose deltas sit closest to the
  // consensus speaks for it on the match card.
  const closest = predictions
    .map((p, i) => ({
      p,
      dist: ["home", "draw", "away", "over"].reduce(
        (a, k) => a + Math.abs((sampleDeltas[i][k] ?? 0) - consensusDeltas[k]),
        0
      ),
    }))
    .sort((a, b) => a.dist - b.dist)[0].p;

  // Cross-field consistency: a big delta claims exceptional evidence, and
  // exceptional evidence cannot be low-confidence. Zero contradictory output.
  let effectiveDeltas = consensusDeltas;
  const maxAbs = Math.max(
    ...["home", "draw", "away", "over"].map((k) => Math.abs(consensusDeltas[k]))
  );
  if (maxAbs >= BIG_DELTA && confidence < 50) {
    violations.push(
      `|delta|=${maxAbs.toFixed(1)} with confidence ${confidence} < 50 — self-contradictory, all deltas zeroed`
    );
    effectiveDeltas = { home: 0, draw: 0, away: 0, over: 0 };
  }

  // Skeptic audit: any surviving non-zero proposal must withstand a
  // refute-by-default review of its evidence (specific? recent? unpriced?).
  const keyFactors = Array.isArray(closest.keyFactors) ? closest.keyFactors : [];
  let verification = { status: "skipped", note: null, skepticConfidence: null };
  const hasProposal = ["home", "draw", "away", "over"].some((k) => effectiveDeltas[k] !== 0);
  let finalConfidence = confidence;
  if (hasProposal) {
    const audit = await skepticVerify(data, effectiveDeltas, keyFactors, closest.reasoning);
    addTokens(audit.usage);
    if (audit.verdict === "refute") {
      verification = { status: "refuted", note: audit.note, skepticConfidence: null };
      violations.push(`skeptic refuted: ${audit.note ?? "no note"}`);
      effectiveDeltas = { home: 0, draw: 0, away: 0, over: 0 };
    } else {
      verification = {
        status: audit.error ? "error" : "upheld",
        note: audit.note,
        skepticConfidence: audit.confidence,
      };
      if (audit.confidence != null) {
        finalConfidence = Math.min(finalConfidence, Math.round(audit.confidence));
      }
    }
  }

  const anchored = applyMarketAnchoredDeltas(data.fairProbs, effectiveDeltas);
  violations.push(...anchored.violations);

  if (violations.length) {
    console.log(`[analyze] ${data.home} vs ${data.away} — protocol notes: ${violations.join(" | ")}`);
  }
  console.log(
    `[analyze] ${data.home} vs ${data.away} — samples=${predictions.length} gap=${disagreement} deltas=${JSON.stringify(anchored.appliedDeltas)} conf=${finalConfidence} verify=${verification.status} tokens in=${tokens.input} out=${tokens.output}`
  );

  return {
    probs: anchored.probs,
    probsExact: anchored.probsExact,
    overUnder: anchored.overUnder,
    overUnderExact: anchored.overUnderExact,
    ouLine,
    confidence: finalConfidence,
    deltas: anchored.appliedDeltas,
    deltasRaw: predictions.map((p) => p.deltas),
    ensemble: {
      samples: predictions.length,
      disagreement,
      tiebreak,
      confidences,
    },
    verification,
    protocolViolations: violations,
    keyFactors,
    reasoning: closest.reasoning,
    reasoningKr: closest.reasoningKr ?? closest.reasoning,
    isFanTeam: data.isFanTeam || false,
    odds: data.odds || null,
    model: MODEL,
    backend: "claude-cli",
    engine: "v2-market-anchored",
    skipped: null,
    tokens,
  };
}
