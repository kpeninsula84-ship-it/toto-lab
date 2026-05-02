import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import {
  getUpcomingMatches,
  getTeamRecentMatches,
  getTeamUpcomingFixtures,
  getHeadToHead,
  getStandings,
  getFinishedMatches,
} from "./footballData.js";
import { getEPLOdds, findOddsForMatch } from "./oddsApi.js";
import { analyzeMatch, fetchTeamInjuries } from "./analyzer.js";
import { devigMatchWinner, devigTwoWay } from "./devig.js";
import { resolveTeamName } from "./teamAliases.js";

initializeApp();
setGlobalOptions({ region: "asia-northeast3", maxInstances: 5 });

const db = getFirestore();
const ARSENAL_TEAM_ID = 57; // football-data.org team id

const EDGE_THRESHOLD = 5;
const CONFIDENCE_THRESHOLD = 50;
const SECONDARY_CONFIDENCE_MIN = 40;
const MAX_PICKS = 3;

function requireAdmin(req, res) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    res.status(503).json({ error: "ADMIN_TOKEN not configured on server" });
    return false;
  }
  const provided = req.get("x-admin-token");
  if (provided !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

const PICK_LABEL_STATIC = {
  home: "홈 승",
  draw: "무승부",
  away: "원정 승",
};

function pickLabel(pick, ouLine) {
  if (pick === "over") return `${ouLine} 오버`;
  if (pick === "under") return `${ouLine} 언더`;
  return PICK_LABEL_STATIC[pick] || pick;
}

// Market book (bet365 or fallback) — used for execution price (EV).
// Reads the legacy flat shape so existing finished-match docs keep working.
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

// Model probability for the chosen pick (Claude output, 0-100 integers).
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

// Fair (de-vigged) probability for the chosen pick (0-1 fractions).
// Returns null when the de-vig couldn't be computed for this market.
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

// Build the fairProbs block used by getFairProbForPick. Prefers the sharp
// book snapshot (Pinnacle/Smarkets/Betfair) when available; otherwise falls
// back to the market book itself, which still benefits from de-vig (just
// against a softer reference). Returns null if no usable odds exist.
function computeFairProbs(odds) {
  if (!odds) return null;
  const sharpMW = odds.fair?.matchWinner ?? odds.market?.matchWinner ?? odds.matchWinner ?? null;
  const sharpTotals = odds.fair?.totals?.best ?? odds.market?.totals?.best ?? odds.overUnder ?? null;
  const out = {};
  // 1X2: Power method (better for 3-way multi-outcome markets)
  const mw = sharpMW ? devigMatchWinner(sharpMW, "power") : null;
  if (mw) out.matchWinner = mw;
  if (sharpTotals?.over && sharpTotals?.under) {
    // O/U: Shin method (designed for 2-way markets with insider-trading correction)
    const tw = devigTwoWay(sharpTotals.over, sharpTotals.under, "shin");
    if (tw) out.overUnder = { line: sharpTotals.line, over: tw[0], under: tw[1] };
  }
  return Object.keys(out).length ? out : null;
}

const FLAT_STAKE = 1000; // for ROI calc

function didPickWin(pick, score, ouLine) {
  if (!pick || score?.home == null || score?.away == null) return null;
  const total = score.home + score.away;
  if (pick === "home") return score.home > score.away;
  if (pick === "draw") return score.home === score.away;
  if (pick === "away") return score.away > score.home;
  if (pick === "over") return total > (ouLine ?? 2.5);
  if (pick === "under") return total < (ouLine ?? 2.5);
  // fallback for legacy picks stored as over25/under25
  if (pick === "over25") return total > 2.5;
  if (pick === "under25") return total < 2.5;
  return null;
}

async function computeAndSaveStats() {
  const snap = await db
    .collection("matches")
    .where("result", "in", ["won", "lost"])
    .get();

  let totalPicks = 0;
  let wins = 0;
  let totalProfit = 0;
  const byPickType = {};

  for (const doc of snap.docs) {
    const m = doc.data();
    if (!m.pick) continue;
    const pickOdds = getOddsForPick(m);
    if (!pickOdds) continue;

    totalPicks++;
    byPickType[m.pick] = byPickType[m.pick] || { count: 0, wins: 0 };
    byPickType[m.pick].count++;

    if (m.result === "won") {
      wins++;
      totalProfit += FLAT_STAKE * (pickOdds - 1);
      byPickType[m.pick].wins++;
    } else {
      totalProfit -= FLAT_STAKE;
    }
  }

  const totalStake = totalPicks * FLAT_STAKE;
  const stats = {
    updatedAt: Timestamp.now(),
    totalPicks,
    wins,
    losses: totalPicks - wins,
    winRate:
      totalPicks > 0 ? Math.round((wins / totalPicks) * 1000) / 10 : 0,
    totalStake,
    totalProfit: Math.round(totalProfit),
    roi:
      totalStake > 0
        ? Math.round((totalProfit / totalStake) * 1000) / 10
        : 0,
    byPickType,
  };

  await db.collection("stats").doc("summary").set(stats);
  console.log(
    `[stats] picks=${totalPicks} wins=${wins} winRate=${stats.winRate}% ROI=${stats.roi}%`
  );
  return stats;
}

async function computeAndSaveRecommendations() {
  const now = Timestamp.now();
  const snap = await db
    .collection("matches")
    .where("kickoff", ">=", now)
    .get();

  const strongCandidates = [];
  const secondaryCandidates = [];
  let totalAnalyzed = 0;
  let droppedNoFair = 0;
  let droppedLowEdge = 0;

  for (const doc of snap.docs) {
    const m = doc.data();
    if (!m.analyzed) continue;
    totalAnalyzed++;

    if (!m.pick) continue;

    const conf = m.confidence ?? 0;
    const pickOdds = getOddsForPick(m);
    if (!pickOdds) continue;

    const pickProb = getProbForPick(m);
    if (pickProb == null) continue;

    // Edge is now computed against the de-vigged sharp book ("fair price"),
    // not the raw market odds Claude saw. This removes the bookmaker's
    // overround from the comparison so a 5%pp edge actually means 5%pp.
    const fairProb = getFairProbForPick(m);
    if (fairProb == null) {
      droppedNoFair++;
      continue;
    }
    const modelProbFraction = pickProb / 100;
    const edgeFair = (modelProbFraction - fairProb) * 100; // percentage points
    if (edgeFair < EDGE_THRESHOLD) {
      droppedLowEdge++;
      continue;
    }

    // EV is the actual betting expectation — use the market (bet365) price.
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
      fairProb: Math.round(fairProb * 1000) / 10, // store as %, 1 decimal
      edge: Math.round(edgeFair * 10) / 10,
      edgeRaw: m.edge ?? null, // keep Claude's self-reported edge for reference
      ev: Math.round(ev * 1000) / 10,
      confidence: conf,
      // sqrt(conf) softens the confidence weighting so a strong-EV pick at
      // conf 50 isn't buried behind a weak-EV pick at conf 80.
      score: Math.round(ev * Math.sqrt(conf / 100) * 100) / 100,
    };

    if (conf >= CONFIDENCE_THRESHOLD) {
      strongCandidates.push(entry);
    } else if (conf >= SECONDARY_CONFIDENCE_MIN) {
      secondaryCandidates.push(entry);
    }
  }

  strongCandidates.sort((a, b) => b.score - a.score);
  secondaryCandidates.sort((a, b) => b.score - a.score);

  const picks = strongCandidates.slice(0, MAX_PICKS);
  const secondaryPicks = secondaryCandidates.slice(0, MAX_PICKS);

  const comboOdds = picks.reduce((acc, p) => acc * p.odds, 1);

  const payload = {
    updatedAt: Timestamp.now(),
    totalAnalyzed,
    totalPassed: strongCandidates.length,
    pickCount: picks.length,
    picks,
    secondaryPicks,
    comboOdds: picks.length >= 2 ? Number(comboOdds.toFixed(2)) : null,
    threshold: { edge: EDGE_THRESHOLD, confidence: CONFIDENCE_THRESHOLD, edgeBasis: "fair_devigged" },
  };

  await db.collection("recommendations").doc("current").set(payload);
  console.log(
    `[recommendations] analyzed=${totalAnalyzed} noFair=${droppedNoFair} lowEdge=${droppedLowEdge} passed=${strongCandidates.length} picks=${picks.length} secondary=${secondaryPicks.length}`
  );
  return payload;
}

export const api = onRequest({ invoker: "public" }, async (req, res) => {
  res.json({
    status: "ok",
    service: "toto-lab",
    time: new Date().toISOString(),
  });
});

// Daily 06:00 KST — pull next 7 days EPL fixtures
export const collectFixtures = onSchedule(
  {
    schedule: "0 6 * * *",
    timeZone: "Asia/Seoul",
    timeoutSeconds: 120,
  },
  async () => {
    const today = new Date();
    const dateFrom = today.toISOString().split("T")[0];
    const weekLater = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    const dateTo = weekLater.toISOString().split("T")[0];

    const matches = await getUpcomingMatches({ dateFrom, dateTo });

    if (!matches.length) {
      console.log(`No EPL fixtures ${dateFrom} ~ ${dateTo}`);
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
          status: m.status, // SCHEDULED / TIMED / IN_PLAY / FINISHED
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
    console.log(`Collected ${matches.length} EPL fixtures ${dateFrom} ~ ${dateTo}`);
  }
);

// Shared analysis runner: fetches matches within [now, now+horizonHours], analyzes, saves recommendations.
async function runScheduledAnalysis(horizonHours, label) {
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
    return (s === "SCHEDULED" || s === "TIMED") && !data.analyzed;
  });

  if (!upcoming.length) {
    console.log(`[${label}] No unanalyzed EPL matches in next ${horizonHours}h`);
    return;
  }

  console.log(`[${label}] analyzing ${upcoming.length} matches (${horizonHours}h window)`);

  const [standings, oddsEvents] = await Promise.all([
    getStandings(),
    getEPLOdds(),
  ]);

  for (const doc of upcoming) {
    const m = doc.data();
    if (m.analyzed) continue;

    try {
      console.log(`[${label}] Analyzing ${m.home} vs ${m.away}`);
      const result = await runFullAnalysis(m, standings, oddsEvents);
      await doc.ref.update({
        ...result,
        analyzed: true,
        analyzedAt: Timestamp.now(),
      });
    } catch (err) {
      console.error(`[${label}] Failed: ${m.home} vs ${m.away} —`, err.message);
      await doc.ref.update({
        analysisError: err.message,
        analysisErrorAt: Timestamp.now(),
      });
    }
  }

  await computeAndSaveRecommendations();
}

// Mon–Fri 12:00 KST — analyze EPL matches in next 24 hours
export const analyzeWeekday = onSchedule(
  {
    schedule: "0 12 * * 1-5",
    timeZone: "Asia/Seoul",
    timeoutSeconds: 540,
  },
  async () => {
    await runScheduledAnalysis(24, "weekday");
  }
);

// Saturday 12:00 KST — analyze EPL matches in next 48 hours (covers Sat evening + all of Sun).
// Sunday has no scheduled analysis run.
export const analyzeSaturday = onSchedule(
  {
    schedule: "0 12 * * 6",
    timeZone: "Asia/Seoul",
    timeoutSeconds: 540,
  },
  async () => {
    await runScheduledAnalysis(48, "saturday");
  }
);

async function runCollectResults() {
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
    if (m.result) continue; // already recorded

    const won = didPickWin(m.pick, f.score, m.ouLine);
    await ref.update({
      finalScore: f.score,
      actualWinner: f.winner,
      result: won === null ? "no_bet" : won ? "won" : "lost",
      resultRecordedAt: Timestamp.now(),
      status: "FINISHED",
    });
    updated++;
  }

  console.log(`[results] updated ${updated} match docs`);
  await computeAndSaveStats();
}

// Daily 09:00 KST
export const collectResults = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Seoul", timeoutSeconds: 120 },
  runCollectResults
);

// Saturday 23:00 KST — picks up Saturday evening results same night
export const collectResultsSatNight = onSchedule(
  { schedule: "0 23 * * 6", timeZone: "Asia/Seoul", timeoutSeconds: 120 },
  runCollectResults
);

// Sunday 23:00 KST — picks up Sunday evening results same night
export const collectResultsSunNight = onSchedule(
  { schedule: "0 23 * * 0", timeZone: "Asia/Seoul", timeoutSeconds: 120 },
  runCollectResults
);

// DISABLED: web_search-based injury collection hits Anthropic rate limits
// and burns tokens. Currently using manual uploads via updateInjuriesBulk instead.
// To re-enable, uncomment below.
//
// export const collectInjuries = onSchedule(
//   {
//     schedule: "0 17 * * 6",
//     timeZone: "Asia/Seoul",
//     timeoutSeconds: 540,
//   },
//   async () => {
//     const standings = await getStandings();
//     const teams = new Map(standings.map((s) => [s.teamId, s.team]));
//     for (const [teamId, teamName] of teams) {
//       try {
//         const injuries = await fetchTeamInjuries(teamName);
//         await db.collection("injuries").doc(String(teamId)).set({
//           teamId, teamName, updatedAt: Timestamp.now(),
//           out: injuries.out || [], doubtful: injuries.doubtful || [],
//         });
//       } catch (err) {
//         console.error(`[injuries] failed for ${teamName}:`, err.message);
//       }
//       await new Promise((r) => setTimeout(r, 8000));
//     }
//   }
// );

// Manual HTTP trigger for collecting injuries
export const collectInjuriesManual = onRequest(
  { invoker: "public", timeoutSeconds: 540 },
  async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const standings = await getStandings();
      const teams = new Map(standings.map((s) => [s.teamId, s.team]));

      console.log(`[injuries-manual] collecting for ${teams.size} teams`);

      const results = [];
      for (const [teamId, teamName] of teams) {
        try {
          const injuries = await fetchTeamInjuries(teamName);
          await db.collection("injuries").doc(String(teamId)).set({
            teamId,
            teamName,
            updatedAt: Timestamp.now(),
            out: injuries.out || [],
            doubtful: injuries.doubtful || [],
          });
          results.push({ teamName, out: injuries.out?.length ?? 0, doubtful: injuries.doubtful?.length ?? 0 });
        } catch (err) {
          results.push({ teamName, error: err.message });
        }
        await new Promise((r) => setTimeout(r, 8000));
      }

      res.json({ ok: true, teams: teams.size, results });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Manual bulk upload of pre-searched injury data.
// POST body: { "Arsenal FC": { out: ["name (reason)"], doubtful: [...] }, ... }
export const updateInjuriesBulk = onRequest(
  { invoker: "public", timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST required" });
      return;
    }
    if (!requireAdmin(req, res)) return;
    try {
      const payload = req.body || {};
      const standings = await getStandings();
      const nameToId = new Map(standings.map((s) => [s.team, s.teamId]));

      const results = [];
      for (const [teamName, data] of Object.entries(payload)) {
        const resolved = resolveTeamName(teamName, nameToId);
        if (!resolved) {
          console.warn(`[injuries] unresolved team name: "${teamName}"`);
          results.push({ teamName, error: "team not found in standings" });
          continue;
        }
        if (resolved.method !== "exact") {
          console.log(`[injuries] "${teamName}" → "${resolved.canonicalName}" (${resolved.method})`);
        }
        const { teamId, canonicalName } = resolved;
        await db.collection("injuries").doc(String(teamId)).set({
          teamId,
          teamName: canonicalName,
          updatedAt: Timestamp.now(),
          out: Array.isArray(data.out) ? data.out : [],
          doubtful: Array.isArray(data.doubtful) ? data.doubtful : [],
        });
        results.push({
          teamName: canonicalName,
          ...(resolved.method !== "exact" && { resolvedFrom: teamName, resolvedVia: resolved.method }),
          out: data.out?.length ?? 0,
          doubtful: data.doubtful?.length ?? 0,
        });
      }

      res.json({ ok: true, updated: results.filter((r) => !r.error).length, results });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Manual HTTP trigger for collecting results
export const collectResultsManual = onRequest(
  { invoker: "public", timeoutSeconds: 120 },
  async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const dateFrom = threeDaysAgo.toISOString().split("T")[0];
      const dateTo = now.toISOString().split("T")[0];

      const finished = await getFinishedMatches({ dateFrom, dateTo });
      let updated = 0;
      for (const f of finished) {
        const ref = db.collection("matches").doc(String(f.fixtureId));
        const snap = await ref.get();
        if (!snap.exists) continue;
        const m = snap.data();
        if (m.result) continue;
        const won = didPickWin(m.pick, f.score, m.ouLine);
        await ref.update({
          finalScore: f.score,
          actualWinner: f.winner,
          result: won === null ? "no_bet" : won ? "won" : "lost",
          resultRecordedAt: Timestamp.now(),
          status: "FINISHED",
        });
        updated++;
      }
      const stats = await computeAndSaveStats();
      res.json({ ok: true, fetched: finished.length, updated, stats });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Re-analyze all upcoming matches in next 36h (useful after injury data update).
// Forces re-analysis even if `analyzed: true`.
export const reanalyzeUpcomingManual = onRequest(
  { invoker: "public", timeoutSeconds: 540 },
  async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const now = Date.now();
      const horizon = Timestamp.fromMillis(now + 36 * 60 * 60 * 1000);

      const snap = await db
        .collection("matches")
        .where("kickoff", ">=", Timestamp.fromMillis(now))
        .where("kickoff", "<=", horizon)
        .get();

      const force = req.query.force === "true";
      const upcoming = snap.docs.filter((d) => {
        const data = d.data();
        const s = data.status;
        return (s === "SCHEDULED" || s === "TIMED") && (force || !data.analyzed);
      });

      if (!upcoming.length) {
        res.json({ ok: true, message: "No upcoming matches in next 36h" });
        return;
      }

      const [standings, oddsEvents] = await Promise.all([
        getStandings(),
        getEPLOdds(),
      ]);

      const results = [];
      for (const doc of upcoming) {
        const m = doc.data();
        try {
          const result = await runFullAnalysis(m, standings, oddsEvents);
          await doc.ref.update({
            ...result,
            analyzed: true,
            analyzedAt: Timestamp.now(),
          });
          results.push({ match: `${m.home} vs ${m.away}`, pick: result.pick, confidence: result.confidence });
        } catch (err) {
          results.push({ match: `${m.home} vs ${m.away}`, error: err.message });
        }
      }

      const recs = await computeAndSaveRecommendations();
      res.json({ ok: true, analyzed: results.length, results, recommendations: recs });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Manual HTTP trigger for testing
// Usage: GET /analyzeManual?fixtureId=12345
export const analyzeManual = onRequest(
  { timeoutSeconds: 540, invoker: "public" },
  async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const fixtureId = req.query.fixtureId;
    if (!fixtureId) {
      res.status(400).json({ error: "fixtureId query param required" });
      return;
    }

    const doc = await db.collection("matches").doc(String(fixtureId)).get();
    if (!doc.exists) {
      res.status(404).json({ error: "fixture not found in Firestore" });
      return;
    }

    try {
      const [standings, oddsEvents] = await Promise.all([
        getStandings(),
        getEPLOdds(),
      ]);
      const result = await runFullAnalysis(doc.data(), standings, oddsEvents);
      await doc.ref.update({
        ...result,
        analyzed: true,
        analyzedAt: Timestamp.now(),
      });
      const recs = await computeAndSaveRecommendations();
      res.json({ ok: true, result, recommendations: recs });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message, stack: err.stack });
    }
  }
);

async function runFullAnalysis(match, standings, oddsEvents) {
  const [homeRecent, awayRecent, homeUpcoming, awayUpcoming, h2h, homeInjuryDoc, awayInjuryDoc] =
    await Promise.all([
      getTeamRecentMatches(match.homeId, 5),
      getTeamRecentMatches(match.awayId, 5),
      getTeamUpcomingFixtures(match.homeId, 5),
      getTeamUpcomingFixtures(match.awayId, 5),
      getHeadToHead(match.fixtureId, 5),
      db.collection("injuries").doc(String(match.homeId)).get(),
      db.collection("injuries").doc(String(match.awayId)).get(),
    ]);

  const homeStanding = standings.find((s) => s.teamId === match.homeId);
  const awayStanding = standings.find((s) => s.teamId === match.awayId);
  const odds = findOddsForMatch(oddsEvents, match.home, match.away);

  const kickoffDate = match.kickoff.toDate();
  const hoursToKickoff = Math.round(
    (kickoffDate.getTime() - Date.now()) / (60 * 60 * 1000)
  );

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
    homeInjuries: homeInjuryDoc.exists ? homeInjuryDoc.data() : null,
    awayInjuries: awayInjuryDoc.exists ? awayInjuryDoc.data() : null,
    isFanTeam:
      match.homeId === ARSENAL_TEAM_ID || match.awayId === ARSENAL_TEAM_ID,
  });

  // Augment the analysis with the fair-probability snapshot so the
  // recommendation engine can compute edge against a de-vigged sharp
  // book instead of raw market odds.
  const fairProbs = computeFairProbs(odds);
  const fairSource = odds?.fair?.bookTitle || odds?.fair?.book || null;

  // Pre-compute the fair (de-vigged) edge for the picked market so the UI
  // can show the same value the recommendation engine uses for selection,
  // instead of Claude's raw self-reported edge against the soft market.
  const matchView = { ...analysis, fairProbs };
  const fairProb = getFairProbForPick(matchView);
  const pickProb = getProbForPick(matchView);
  const edgeFair =
    fairProb != null && pickProb != null
      ? Math.round((pickProb - fairProb * 100) * 10) / 10
      : null;

  return {
    ...analysis,
    fairProbs,
    fairSource,
    edgeFair,
  };
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("[telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping");
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[telegram] sendMessage failed: ${res.status} ${body}`);
  }
}

// Fires when recommendations/current is written.
// Sends a Telegram alert only when new value picks are present.
export const notifyTelegram = onDocumentWritten(
  { document: "recommendations/current", region: "asia-northeast3" },
  async (event) => {
    const after = event.data?.after?.data();
    if (!after) return;

    const picks = after.picks || [];
    if (picks.length === 0) return;

    // Avoid re-notifying for the same set of picks (compare pick fixture IDs).
    const before = event.data?.before?.data();
    const beforeIds = (before?.picks || []).map((p) => p.fixtureId).sort().join(",");
    const afterIds = picks.map((p) => p.fixtureId).sort().join(",");
    if (beforeIds === afterIds) return;

    const PICK_LABEL_KR = {
      home: "홈 승", draw: "무승부", away: "원정 승",
    };
    const pickLines = picks.map((p, i) => {
      const kickoff = p.kickoff?.toDate ? p.kickoff.toDate() : new Date(p.kickoff);
      const dateStr = kickoff.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const label = p.pickLabel || PICK_LABEL_KR[p.pick] || p.pick;
      return `${i + 1}. <b>${p.home} vs ${p.away}</b> (${dateStr})\n   ${label} @${p.odds} · Edge +${p.edge}% · EV +${p.ev}%`;
    }).join("\n\n");

    const acca = after.comboOdds
      ? `\n\n🎲 어큐뮬레이터: <b>${after.comboOdds}x</b> (£10 → £${(10 * after.comboOdds).toFixed(2)})`
      : "";

    const msg = `⚽ <b>TotoLab — 새 값 픽 ${picks.length}개</b>\n\n${pickLines}${acca}`;
    await sendTelegram(msg);
  }
);
