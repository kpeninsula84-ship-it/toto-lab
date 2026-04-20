import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
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
import { analyzeMatch } from "./analyzer.js";

initializeApp();
setGlobalOptions({ region: "asia-northeast3", maxInstances: 5 });

const db = getFirestore();
const ARSENAL_TEAM_ID = 57; // football-data.org team id

const EDGE_THRESHOLD = 5;
const CONFIDENCE_THRESHOLD = 50;
const MAX_PICKS = 3;

const PICK_LABEL = {
  home: "홈 승",
  draw: "무승부",
  away: "원정 승",
  over25: "2.5 오버",
  under25: "2.5 언더",
};

function getOddsForPick(match) {
  const { pick, odds } = match;
  if (!pick || !odds) return null;
  if (pick === "home") return odds.matchWinner?.home ?? null;
  if (pick === "draw") return odds.matchWinner?.draw ?? null;
  if (pick === "away") return odds.matchWinner?.away ?? null;
  if (pick === "over25") return odds.overUnder25?.over ?? null;
  if (pick === "under25") return odds.overUnder25?.under ?? null;
  return null;
}

const FLAT_STAKE = 1000; // for ROI calc

function didPickWin(pick, score) {
  if (!pick || score?.home == null || score?.away == null) return null;
  const total = score.home + score.away;
  if (pick === "home") return score.home > score.away;
  if (pick === "draw") return score.home === score.away;
  if (pick === "away") return score.away > score.home;
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

  const candidates = [];
  let totalAnalyzed = 0;

  for (const doc of snap.docs) {
    const m = doc.data();
    if (!m.analyzed) continue;
    totalAnalyzed++;

    if (!m.pick) continue;
    if ((m.edge ?? 0) < EDGE_THRESHOLD) continue;
    if ((m.confidence ?? 0) < CONFIDENCE_THRESHOLD) continue;

    const pickOdds = getOddsForPick(m);
    if (!pickOdds) continue;

    candidates.push({
      fixtureId: m.fixtureId,
      home: m.home,
      away: m.away,
      kickoff: m.kickoff,
      pick: m.pick,
      pickLabel: PICK_LABEL[m.pick] || m.pick,
      odds: pickOdds,
      edge: m.edge,
      confidence: m.confidence,
      score: Math.round((m.edge * m.confidence) / 100),
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const picks = candidates.slice(0, MAX_PICKS);

  const comboOdds = picks.reduce((acc, p) => acc * p.odds, 1);

  const payload = {
    updatedAt: Timestamp.now(),
    totalAnalyzed,
    totalPassed: candidates.length,
    pickCount: picks.length,
    picks,
    comboOdds: picks.length >= 2 ? Number(comboOdds.toFixed(2)) : null,
    threshold: { edge: EDGE_THRESHOLD, confidence: CONFIDENCE_THRESHOLD },
  };

  await db.collection("recommendations").doc("current").set(payload);
  console.log(
    `[recommendations] analyzed=${totalAnalyzed} passed=${candidates.length} picks=${picks.length}`
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

// Daily 18:00 KST — analyze EPL matches in next 36 hours (covers weekend + midweek)
export const analyzeDaily = onSchedule(
  {
    schedule: "0 18 * * *",
    timeZone: "Asia/Seoul",
    timeoutSeconds: 540,
  },
  async () => {
    const now = Date.now();
    const horizon = Timestamp.fromMillis(now + 36 * 60 * 60 * 1000);

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
      console.log("No unanalyzed EPL matches in next 36h");
      return;
    }

    console.log(`[daily] analyzing ${upcoming.length} matches`);

    const [standings, oddsEvents] = await Promise.all([
      getStandings(),
      getEPLOdds(),
    ]);

    for (const doc of upcoming) {
      const m = doc.data();
      if (m.analyzed) continue;

      try {
        console.log(`Analyzing ${m.home} vs ${m.away}`);
        const result = await runFullAnalysis(m, standings, oddsEvents);
        await doc.ref.update({
          ...result,
          analyzed: true,
          analyzedAt: Timestamp.now(),
        });
      } catch (err) {
        console.error(`Failed: ${m.home} vs ${m.away} —`, err.message);
        await doc.ref.update({
          analysisError: err.message,
          analysisErrorAt: Timestamp.now(),
        });
      }
    }

    await computeAndSaveRecommendations();
  }
);

// Daily 09:00 KST — fetch finished match results, update Firestore, recompute stats
export const collectResults = onSchedule(
  {
    schedule: "0 9 * * *",
    timeZone: "Asia/Seoul",
    timeoutSeconds: 120,
  },
  async () => {
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

      const won = didPickWin(m.pick, f.score);
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
);

// Manual HTTP trigger for collecting results
export const collectResultsManual = onRequest(
  { invoker: "public", timeoutSeconds: 120 },
  async (req, res) => {
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
        const won = didPickWin(m.pick, f.score);
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

// Manual HTTP trigger for testing
// Usage: GET /analyzeManual?fixtureId=12345
export const analyzeManual = onRequest(
  { timeoutSeconds: 540, invoker: "public" },
  async (req, res) => {
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
  const [homeRecent, awayRecent, homeUpcoming, awayUpcoming, h2h] =
    await Promise.all([
      getTeamRecentMatches(match.homeId, 10),
      getTeamRecentMatches(match.awayId, 10),
      getTeamUpcomingFixtures(match.homeId, 5),
      getTeamUpcomingFixtures(match.awayId, 5),
      getHeadToHead(match.fixtureId, 5),
    ]);

  const homeStanding = standings.find((s) => s.teamId === match.homeId);
  const awayStanding = standings.find((s) => s.teamId === match.awayId);
  const odds = findOddsForMatch(oddsEvents, match.home, match.away);

  const kickoffDate = match.kickoff.toDate();
  const hoursToKickoff = Math.round(
    (kickoffDate.getTime() - Date.now()) / (60 * 60 * 1000)
  );

  return await analyzeMatch({
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
    isFanTeam:
      match.homeId === ARSENAL_TEAM_ID || match.awayId === ARSENAL_TEAM_ID,
  });
}
