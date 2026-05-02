// Analysis pipeline that runs from a worker (Mac/NAS) instead of Firebase
// Functions. Combines fixture collection, ai-debate analysis, and
// recommendation generation. Writes back to Firestore via the Admin SDK.
//
// Mirrors the behavior of functions/index.js's collectFixtures,
// runScheduledAnalysis, and computeAndSaveRecommendations.

import { Timestamp } from "firebase-admin/firestore";
import { db } from "./firestore.js";
import {
  getUpcomingMatches,
  getTeamRecentMatches,
  getTeamUpcomingFixtures,
  getHeadToHead,
  getStandings,
  getFinishedMatches,
} from "../functions/footballData.js";
import { getEPLOdds, getEPLTeamTotals, findOddsForMatch } from "../functions/oddsApi.js";
import { devigMatchWinner, devigTwoWay } from "../functions/devig.js";
import { analyzeMatch, fetchTeamInjuries } from "./analyzer.js";

export const ARSENAL_TEAM_ID = 57;
export const EDGE_THRESHOLD = 5;
export const CONFIDENCE_THRESHOLD = 50;
export const SECONDARY_CONFIDENCE_MIN = 40;
export const MAX_PICKS = 3;

// ---- pick helpers (mirror functions/index.js) ------------------------------
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
  if (pick === "home") return match.probs?.home ?? null;
  if (pick === "draw") return match.probs?.draw ?? null;
  if (pick === "away") return match.probs?.away ?? null;
  if (pick === "over") return match.overUnder?.over ?? null;
  if (pick === "under") return match.overUnder?.under ?? null;
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

function pickLabel(pick, ouLine) {
  if (pick === "over") return `${ouLine} 오버`;
  if (pick === "under") return `${ouLine} 언더`;
  if (pick === "home") return "홈 승";
  if (pick === "draw") return "무승부";
  if (pick === "away") return "원정 승";
  return pick;
}

// ---- collectFixtures -------------------------------------------------------
export async function collectFixtures(daysAhead = 7) {
  const today = new Date();
  const dateFrom = today.toISOString().split("T")[0];
  const later = new Date(today.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const dateTo = later.toISOString().split("T")[0];

  const matches = await getUpcomingMatches({ dateFrom, dateTo });
  if (!matches.length) {
    console.log(`[fixtures] no EPL matches ${dateFrom} ~ ${dateTo}`);
    return;
  }

  const batch = db.batch();
  for (const m of matches) {
    const ref = db.collection("matches").doc(String(m.id));
    batch.set(
      ref,
      {
        fixtureId: m.id,
        league: "EPL",
        matchday: m.matchday,
        kickoff: Timestamp.fromDate(new Date(m.utcDate)),
        status: m.status,
        home: m.homeTeam.name,
        homeId: m.homeTeam.id,
        homeShort: m.homeTeam.shortName,
        away: m.awayTeam.name,
        awayId: m.awayTeam.id,
        awayShort: m.awayTeam.shortName,
        collectedAt: Timestamp.now(),
      },
      { merge: true }
    );
  }
  await batch.commit();
  console.log(`[fixtures] collected ${matches.length} EPL fixtures ${dateFrom} ~ ${dateTo}`);
}

// ---- runFullAnalysis (per-match) ------------------------------------------
async function runFullAnalysis(match, standings, oddsEvents, teamTotalsEvents) {
  const [homeRecent, awayRecent, homeUpcoming, awayUpcoming, h2h, homeInjuries, awayInjuries] =
    await Promise.all([
      getTeamRecentMatches(match.homeId, 5),
      getTeamRecentMatches(match.awayId, 5),
      getTeamUpcomingFixtures(match.homeId, 5),
      getTeamUpcomingFixtures(match.awayId, 5),
      getHeadToHead(match.fixtureId, 5),
      fetchTeamInjuries(match.home),
      fetchTeamInjuries(match.away),
    ]);

  const homeStanding = standings.find((s) => s.teamId === match.homeId);
  const awayStanding = standings.find((s) => s.teamId === match.awayId);
  const odds = findOddsForMatch(oddsEvents, match.home, match.away, teamTotalsEvents);
  const kickoffDate = match.kickoff.toDate();
  const hoursToKickoff = Math.round((kickoffDate.getTime() - Date.now()) / 3600_000);

  const analysis = await analyzeMatch({
    home: match.home,
    away: match.away,
    kickoff: kickoffDate.toISOString(),
    hoursToKickoff,
    homeRecent,
    awayRecent,
    homeUpcoming,
    awayUpcoming,
    h2h,
    homeStanding,
    awayStanding,
    odds,
    homeInjuries,
    awayInjuries,
    isFanTeam: match.homeId === ARSENAL_TEAM_ID || match.awayId === ARSENAL_TEAM_ID,
  });

  // Persist injuries snapshot for transparency / audit
  const injuriesSnapshot = { home: homeInjuries, away: awayInjuries };

  // Pre-compute fair edge for the picked market so the UI/notifier reads
  // the same value used for selection.
  const fairProbs = computeFairProbs(odds);
  const fairSource = odds?.fair?.bookTitle || odds?.fair?.book || null;
  const matchView = { ...analysis, fairProbs };
  const fairProb = getFairProbForPick(matchView);
  const pickProb = getProbForPick(matchView);
  const edgeFair =
    fairProb != null && pickProb != null
      ? Math.round((pickProb - fairProb * 100) * 10) / 10
      : null;

  return { ...analysis, fairProbs, fairSource, edgeFair, injuriesSnapshot };
}

// ---- runScheduledAnalysis -------------------------------------------------
export async function runScheduledAnalysis(horizonHours = 48, label = "manual", { force = false } = {}) {
  const now = Date.now();
  const horizon = Timestamp.fromMillis(now + horizonHours * 60 * 60 * 1000);

  const snap = await db
    .collection("matches")
    .where("kickoff", ">=", Timestamp.fromMillis(now))
    .where("kickoff", "<=", horizon)
    .get();

  const upcoming = snap.docs.filter((d) => {
    const data = d.data();
    const s = data.status;
    return (s === "SCHEDULED" || s === "TIMED") && (force || !data.analyzed);
  });

  if (!upcoming.length) {
    console.log(`[${label}] no unanalyzed EPL matches in next ${horizonHours}h`);
    return;
  }

  console.log(`[${label}] analyzing ${upcoming.length} matches (${horizonHours}h window)`);

  const [standings, oddsEvents, teamTotalsEvents] = await Promise.all([
    getStandings(),
    getEPLOdds(),
    getEPLTeamTotals(),
  ]);

  for (const doc of upcoming) {
    const m = doc.data();
    try {
      console.log(`[${label}] analyzing ${m.home} vs ${m.away}`);
      const result = await runFullAnalysis(m, standings, oddsEvents, teamTotalsEvents);
      await doc.ref.update({ ...result, analyzed: true, analyzedAt: Timestamp.now() });
    } catch (err) {
      console.error(`[${label}] failed: ${m.home} vs ${m.away} —`, err.message);
      await doc.ref.update({
        analysisError: err.message,
        analysisErrorAt: Timestamp.now(),
      });
    }
  }

  await computeAndSaveRecommendations();
}

// ---- computeAndSaveRecommendations ----------------------------------------
export async function computeAndSaveRecommendations() {
  const now = Timestamp.now();
  const snap = await db.collection("matches").where("kickoff", ">=", now).get();

  const strong = [];
  const secondary = [];
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
    else if (conf >= SECONDARY_CONFIDENCE_MIN) secondary.push(entry);
  }

  strong.sort((a, b) => b.score - a.score);
  secondary.sort((a, b) => b.score - a.score);

  const picks = strong.slice(0, MAX_PICKS);
  const secondaryPicks = secondary.slice(0, MAX_PICKS);
  const comboOdds = picks.reduce((acc, p) => acc * p.odds, 1);

  const payload = {
    updatedAt: Timestamp.now(),
    totalAnalyzed,
    totalPassed: strong.length,
    pickCount: picks.length,
    picks,
    secondaryPicks,
    comboOdds: picks.length >= 2 ? Number(comboOdds.toFixed(2)) : null,
    threshold: { edge: EDGE_THRESHOLD, confidence: CONFIDENCE_THRESHOLD, edgeBasis: "fair_devigged" },
    backend: "ai-debate",
  };

  await db.collection("recommendations").doc("current").set(payload);
  console.log(`[recommendations] analyzed=${totalAnalyzed} passed=${strong.length} picks=${picks.length} secondary=${secondaryPicks.length}`);
  return payload;
}

// ---- collectResults --------------------------------------------------------
function didPickWin(pick, score, ouLine) {
  if (!pick || score?.home == null || score?.away == null) return null;
  const total = score.home + score.away;
  if (pick === "home") return score.home > score.away;
  if (pick === "draw") return score.home === score.away;
  if (pick === "away") return score.away > score.home;
  if (pick === "over") return total > (ouLine ?? 2.5);
  if (pick === "under") return total < (ouLine ?? 2.5);
  if (pick === "over25") return total > 2.5;
  if (pick === "under25") return total < 2.5;
  return null;
}

export async function collectResults() {
  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const dateFrom = threeDaysAgo.toISOString().split("T")[0];
  const dateTo = now.toISOString().split("T")[0];

  const finished = await getFinishedMatches({ dateFrom, dateTo });
  console.log(`[results] fetched ${finished.length} finished matches`);

  let updated = 0;
  for (const f of finished) {
    const ref = db.collection("matches").doc(String(f.fixtureId));
    const snap = await ref.get();
    if (!snap.exists) continue;
    const m = snap.data();
    const won = didPickWin(m.pick, f.score, m.ouLine);
    await ref.update({
      finalScore: f.score,
      result: won == null ? null : won ? "won" : "lost",
      finishedAt: Timestamp.now(),
    });
    updated++;
  }
  console.log(`[results] updated ${updated} matches`);
}
