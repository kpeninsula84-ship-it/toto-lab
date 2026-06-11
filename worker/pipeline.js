// Analysis pipeline — runs daily at 12:00 KST on GitHub Actions (worker.yml).
// Re-analyzes every EPL match kicking off in the next 24 hours, so each
// run picks up the freshest injury, odds, and form data.
//
// Fixture collection (06:00 KST) and result collection (09:00 + Sat/Sun
// 23:00 KST) live in functions/index.js. This worker is analysis-only.

import { Timestamp } from "firebase-admin/firestore";
import { db } from "./firestore.js";
import {
  getTeamRecentMatches,
  getTeamUpcomingFixtures,
  getStandings,
} from "../functions/footballData.js";
import { getEPLOdds, getEPLTeamTotals, findOddsForMatch } from "../functions/oddsApi.js";
import { devigMatchWinner, devigTwoWay } from "../functions/devig.js";
import { analyzeMatch, fetchTeamInjuries } from "./analyzer.js";

export const ARSENAL_TEAM_ID = 57;
export const EDGE_THRESHOLD = 5;
export const CONFIDENCE_THRESHOLD = 50;
export const MAX_PICKS = 3;
export const DEFAULT_HORIZON_HOURS = 24;

// pick helpers ---------------------------------------------------------------
function getOddsForPick(match) {
  const { pick, odds } = match;
  if (!pick || !odds) return null;
  if (pick === "home") return odds.matchWinner?.home ?? null;
  if (pick === "draw") return odds.matchWinner?.draw ?? null;
  if (pick === "away") return odds.matchWinner?.away ?? null;
  if (pick === "over") return odds.overUnder?.over ?? null;
  if (pick === "under") return odds.overUnder?.under ?? null;
  return null;
}

function getProbForPick(match) {
  const { pick } = match;
  if (!pick) return null;
  // Prefer fractional probabilities (engine v2) — integer rounding adds
  // ±1pp noise right on the edge threshold.
  const probs = match.probsExact ?? match.probs;
  const ou = match.overUnderExact ?? match.overUnder;
  if (pick === "home") return probs?.home ?? null;
  if (pick === "draw") return probs?.draw ?? null;
  if (pick === "away") return probs?.away ?? null;
  if (pick === "over") return ou?.over ?? null;
  if (pick === "under") return ou?.under ?? null;
  return null;
}

function getFairProbForPick(match) {
  const { pick, fairProbs } = match;
  if (!pick || !fairProbs) return null;
  if (pick === "home") return fairProbs.matchWinner?.home ?? null;
  if (pick === "draw") return fairProbs.matchWinner?.draw ?? null;
  if (pick === "away") return fairProbs.matchWinner?.away ?? null;
  if (pick === "over") return fairProbs.overUnder?.over ?? null;
  if (pick === "under") return fairProbs.overUnder?.under ?? null;
  return null;
}

export function computeFairProbs(odds) {
  if (!odds) return null;
  const sharpMW = odds.fair?.matchWinner ?? odds.market?.matchWinner ?? odds.matchWinner ?? null;
  const out = {};
  const mw = sharpMW ? devigMatchWinner(sharpMW, "power") : null;
  if (mw) out.matchWinner = mw;

  // O/U: de-vig at the SAME line as the market's chosen (most balanced)
  // line so the baseline, the model output, and the execution price all
  // refer to one line. Prefer the sharp book's price at that line; fall
  // back to de-vigging the market book's own price.
  const ouRef = odds.overUnder ?? odds.market?.totals?.best ?? null;
  if (ouRef?.over && ouRef?.under && ouRef.line != null) {
    const sharpAt =
      (odds.fair?.totals?.all ?? []).find((l) => l.line === ouRef.line) ??
      (odds.fair?.totals?.best?.line === ouRef.line ? odds.fair.totals.best : null);
    const src = sharpAt ?? ouRef;
    const tw = devigTwoWay(src.over, src.under, "shin");
    if (tw) out.overUnder = { line: ouRef.line, over: tw[0], under: tw[1] };
  }
  return Object.keys(out).length ? out : null;
}

// Pick = outcome with the largest model-vs-fair edge among outcomes that
// have an execution price; null when the best edge is under threshold.
function selectPick(analysis, fairProbs) {
  const candidates = [];
  const probs = analysis.probsExact ?? analysis.probs;
  const ou = analysis.overUnderExact ?? analysis.overUnder;
  if (probs && fairProbs?.matchWinner) {
    for (const k of ["home", "draw", "away"]) {
      const fair = fairProbs.matchWinner[k];
      const price = getOddsForPick({ pick: k, odds: analysis.odds });
      if (fair == null || price == null) continue;
      candidates.push({ pick: k, edge: probs[k] - fair * 100 });
    }
  }
  if (ou && fairProbs?.overUnder) {
    for (const k of ["over", "under"]) {
      const fair = fairProbs.overUnder[k];
      const price = getOddsForPick({ pick: k, odds: analysis.odds });
      if (fair == null || price == null) continue;
      candidates.push({ pick: k, edge: ou[k] - fair * 100 });
    }
  }
  if (!candidates.length) return { pick: null, edgeFair: null };
  candidates.sort((a, b) => b.edge - a.edge);
  const best = candidates[0];
  const edgeFair = Math.round(best.edge * 10) / 10;
  return best.edge >= EDGE_THRESHOLD
    ? { pick: best.pick, edgeFair }
    : { pick: null, edgeFair };
}

function pickLabel(pick, ouLine) {
  if (pick === "over") return `${ouLine} 오버`;
  if (pick === "under") return `${ouLine} 언더`;
  if (pick === "home") return "홈 승";
  if (pick === "draw") return "무승부";
  if (pick === "away") return "원정 승";
  return pick;
}

// per-match analysis ---------------------------------------------------------
async function runFullAnalysis(match, standings, oddsEvents, teamTotalsEvents) {
  // H2H is no longer fetched — the market prices it better than the model
  // can read it from 5 samples, and feeding it invited re-pricing of
  // already-priced information.
  const [homeRecent, awayRecent, homeUpcoming, awayUpcoming, homeInjuries, awayInjuries] =
    await Promise.all([
      getTeamRecentMatches(match.homeId, 5),
      getTeamRecentMatches(match.awayId, 5),
      getTeamUpcomingFixtures(match.homeId, 5),
      getTeamUpcomingFixtures(match.awayId, 5),
      fetchTeamInjuries(match.home),
      fetchTeamInjuries(match.away),
    ]);

  const homeStanding = standings.find((s) => s.teamId === match.homeId);
  const awayStanding = standings.find((s) => s.teamId === match.awayId);
  const odds = findOddsForMatch(oddsEvents, match.home, match.away, teamTotalsEvents);
  const kickoffDate = match.kickoff.toDate();
  const hoursToKickoff = Math.round((kickoffDate.getTime() - Date.now()) / 3600_000);

  // The fair baseline is computed BEFORE the model call — engine v2 hands
  // it to Claude as the anchor and only accepts deltas against it.
  const fairProbs = computeFairProbs(odds);
  const fairSource = odds?.fair?.bookTitle || odds?.fair?.book || (odds ? "market book (no sharp)" : null);

  const analysis = await analyzeMatch({
    home: match.home,
    away: match.away,
    kickoff: kickoffDate.toISOString(),
    hoursToKickoff,
    homeRecent,
    awayRecent,
    homeUpcoming,
    awayUpcoming,
    homeStanding,
    awayStanding,
    odds,
    fairProbs,
    fairSource,
    homeInjuries,
    awayInjuries,
    isFanTeam: match.homeId === ARSENAL_TEAM_ID || match.awayId === ARSENAL_TEAM_ID,
  });

  const injuriesSnapshot = { home: homeInjuries, away: awayInjuries };
  const { pick, edgeFair } = selectPick(analysis, fairProbs);

  return {
    ...analysis,
    fairProbs,
    fairSource,
    pick,
    edge: edgeFair, // legacy field name kept for the frontend/stats
    edgeFair,
    injuriesSnapshot,
  };
}

// Heartbeat for the frontend's "last analysis" line and for debugging
// run history. Logging must never fail the run itself.
async function logRun(fields) {
  try {
    await db.collection("runs").add({
      ...fields,
      finishedAt: Timestamp.now(),
      engine: "v2-market-anchored",
    });
  } catch (err) {
    console.error(`[runs] failed to log run: ${err.message}`);
  }
}

// main entry — analyze every SCHEDULED/TIMED match in the next horizon -------
export async function runScheduledAnalysis(horizonHours = DEFAULT_HORIZON_HOURS, label = "worker") {
  const startedAt = Timestamp.now();
  const now = Date.now();
  const horizon = Timestamp.fromMillis(now + horizonHours * 60 * 60 * 1000);

  const snap = await db
    .collection("matches")
    .where("kickoff", ">=", Timestamp.fromMillis(now))
    .where("kickoff", "<=", horizon)
    .get();

  const upcoming = snap.docs.filter((d) => {
    const s = d.data().status;
    return s === "SCHEDULED" || s === "TIMED";
  });

  if (!upcoming.length) {
    console.log(`[${label}] no upcoming EPL matches in next ${horizonHours}h`);
    // Still refresh recommendations/current — otherwise the site keeps
    // showing the previous round's picks indefinitely (e.g. all off-season).
    const payload = await computeAndSaveRecommendations();
    await logRun({
      startedAt,
      label,
      horizonHours,
      matches: 0,
      analyzed: 0,
      errors: 0,
      picks: payload?.pickCount ?? 0,
    });
    return;
  }

  console.log(`[${label}] analyzing ${upcoming.length} matches (${horizonHours}h window)`);

  const [standings, oddsEvents, teamTotalsEvents] = await Promise.all([
    getStandings(),
    getEPLOdds(),
    getEPLTeamTotals(),
  ]);

  let analyzedCount = 0;
  let errorCount = 0;
  for (const doc of upcoming) {
    const m = doc.data();
    try {
      console.log(`[${label}] analyzing ${m.home} vs ${m.away}`);
      const result = await runFullAnalysis(m, standings, oddsEvents, teamTotalsEvents);
      // A skipped analysis (no odds yet) stays "pending" so the frontend
      // doesn't render it as an analysed no-value match.
      await doc.ref.update({ ...result, analyzed: !result.skipped, analyzedAt: Timestamp.now() });
      analyzedCount++;
    } catch (err) {
      console.error(`[${label}] failed: ${m.home} vs ${m.away} —`, err.message);
      errorCount++;
      await doc.ref.update({
        analysisError: err.message,
        analysisErrorAt: Timestamp.now(),
      });
    }
  }

  const payload = await computeAndSaveRecommendations();
  await logRun({
    startedAt,
    label,
    horizonHours,
    matches: upcoming.length,
    analyzed: analyzedCount,
    errors: errorCount,
    picks: payload?.pickCount ?? 0,
  });
}

// recommendations ------------------------------------------------------------
export async function computeAndSaveRecommendations() {
  const now = Timestamp.now();
  const snap = await db.collection("matches").where("kickoff", ">=", now).get();

  // Engine v2 discards big-delta/low-confidence output upstream, so a
  // sub-threshold-confidence tier would only display picks the engine
  // has already decided not to trust. Strong tier only.
  const strong = [];
  let totalAnalyzed = 0;

  for (const doc of snap.docs) {
    const m = doc.data();
    if (!m.analyzed || !m.pick) continue;
    totalAnalyzed++;

    const conf = m.confidence ?? 0;
    const pickOdds = getOddsForPick(m);
    if (!pickOdds) continue;

    const pickProb = getProbForPick(m);
    if (pickProb == null) continue;

    const fairProb = getFairProbForPick(m);
    if (fairProb == null) continue;

    const modelProbFraction = pickProb / 100;
    const edgeFair = (modelProbFraction - fairProb) * 100;
    if (edgeFair < EDGE_THRESHOLD) continue;

    const ev = modelProbFraction * pickOdds - 1;

    const entry = {
      fixtureId: m.fixtureId,
      home: m.home,
      away: m.away,
      kickoff: m.kickoff,
      pick: m.pick,
      pickLabel: pickLabel(m.pick, m.ouLine ?? 2.5),
      odds: pickOdds,
      prob: pickProb,
      fairProb: Math.round(fairProb * 1000) / 10,
      edge: Math.round(edgeFair * 10) / 10,
      edgeRaw: m.edge ?? null,
      ev: Math.round(ev * 1000) / 10,
      confidence: conf,
      score: Math.round(ev * Math.sqrt(conf / 100) * 100) / 100,
    };

    if (conf >= CONFIDENCE_THRESHOLD) strong.push(entry);
  }

  strong.sort((a, b) => b.score - a.score);

  const picks = strong.slice(0, MAX_PICKS);
  const comboOdds = picks.reduce((acc, p) => acc * p.odds, 1);

  const payload = {
    updatedAt: Timestamp.now(),
    totalAnalyzed,
    totalPassed: strong.length,
    pickCount: picks.length,
    picks,
    comboOdds: picks.length >= 2 ? Number(comboOdds.toFixed(2)) : null,
    threshold: { edge: EDGE_THRESHOLD, confidence: CONFIDENCE_THRESHOLD, edgeBasis: "fair_devigged" },
    backend: "claude-cli",
  };

  await db.collection("recommendations").doc("current").set(payload);
  console.log(`[recommendations] analyzed=${totalAnalyzed} passed=${strong.length} picks=${picks.length}`);
  return payload;
}
