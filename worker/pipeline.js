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
  getHeadToHead,
  getStandings,
} from "../functions/footballData.js";
import { getEPLOdds, getEPLTeamTotals, findOddsForMatch } from "../functions/oddsApi.js";
import { devigMatchWinner, devigTwoWay } from "../functions/devig.js";
import { analyzeMatch, fetchTeamInjuries } from "./analyzer.js";

export const ARSENAL_TEAM_ID = 57;
export const EDGE_THRESHOLD = 5;
export const CONFIDENCE_THRESHOLD = 50;
export const SECONDARY_CONFIDENCE_MIN = 40;
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

// per-match analysis ---------------------------------------------------------
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

  const injuriesSnapshot = { home: homeInjuries, away: awayInjuries };
  const fairProbs = computeFairProbs(odds);
  const fairSource = odds?.fair?.bookTitle || odds?.fair?.book || null;
  const matchView = { ...analysis, fairProbs };
  const fairProb = getFairProbForPick(matchView);
  const pickProb = getProbForPick(matchView);
  const edgeFair =
    fairProb != null && pickProb != null
      ? Math.round((pickProb - fairProb * 100) * 10) / 10
      : null;

  const result = { ...analysis, fairProbs, fairSource, edgeFair, injuriesSnapshot };

  // A pick we can't price can't be staked or settled — last season three
  // picks were graded with no stored odds, corrupting the track record.
  if (result.pick && getOddsForPick(result) == null) {
    console.log(
      `[pipeline] ${match.home} vs ${match.away}: dropping pick "${result.pick}" — no stored odds for it`
    );
    result.pick = null;
    result.pickDropped = "no_stored_odds";
  }

  return result;
}

// main entry — analyze every SCHEDULED/TIMED match in the next horizon -------
export async function runScheduledAnalysis(horizonHours = DEFAULT_HORIZON_HOURS, label = "worker") {
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
    await computeAndSaveRecommendations();
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

// recommendations ------------------------------------------------------------
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
    backend: "claude-cli",
  };

  await db.collection("recommendations").doc("current").set(payload);
  console.log(`[recommendations] analyzed=${totalAnalyzed} passed=${strong.length} picks=${picks.length} secondary=${secondaryPicks.length}`);
  return payload;
}
