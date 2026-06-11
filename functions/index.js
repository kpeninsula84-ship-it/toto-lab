import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getUpcomingMatches, getFinishedMatches } from "./footballData.js";

initializeApp();
setGlobalOptions({ region: "asia-northeast3", maxInstances: 5 });

const db = getFirestore();

const FLAT_STAKE = 1000; // for ROI calc

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

// Market book (bet365 or fallback) — used for execution price (EV).
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

// Returns true/false for win/loss, "push" when an O/U total lands exactly
// on a whole-number line (stake returned — neither won nor lost), or null
// when there is no settleable pick.
function didPickWin(pick, score, ouLine) {
  if (!pick || score?.home == null || score?.away == null) return null;
  const total = score.home + score.away;
  if (pick === "home") return score.home > score.away;
  if (pick === "draw") return score.home === score.away;
  if (pick === "away") return score.away > score.home;
  if (pick === "over" || pick === "under" || pick === "over25" || pick === "under25") {
    // over25/under25 are legacy picks with an implicit 2.5 line
    const line = pick.endsWith("25") ? 2.5 : (ouLine ?? 2.5);
    if (total === line) return "push";
    return pick.startsWith("over") ? total > line : total < line;
  }
  return null;
}

function resultLabel(won) {
  if (won === null) return "no_bet";
  if (won === "push") return "push";
  return won ? "won" : "lost";
}

// Closing price + de-vigged closing fair prob for the pick, from the
// `closingOdds` snapshot the worker captures shortly before kickoff.
// O/U values only count when the closing line matches the pick's line.
function closingForPick(m) {
  const c = m.closingOdds;
  if (!c || !m.pick) return { price: null, fairProb: null };
  if (m.pick === "home" || m.pick === "draw" || m.pick === "away") {
    return {
      price: c.matchWinner?.[m.pick] ?? null,
      fairProb: c.fair?.matchWinner?.[m.pick] ?? null,
    };
  }
  if (m.pick === "over" || m.pick === "under") {
    const line = m.ouLine ?? null;
    return {
      price: line != null && c.overUnder?.line === line ? c.overUnder[m.pick] ?? null : null,
      fairProb:
        line != null && c.fair?.overUnder?.line === line ? c.fair.overUnder[m.pick] ?? null : null,
    };
  }
  return { price: null, fairProb: null };
}

// CLV (%) = taken price vs closing price; evClose (%) = EV of the taken
// price measured against the de-vigged closing probability. Positive
// values mean we beat the close — the strongest small-sample signal
// that the engine adds value.
function computeClvFields(m) {
  const pickOdds = getOddsForPick(m);
  if (!m.pick || !pickOdds) return null;
  const { price, fairProb } = closingForPick(m);
  const out = {};
  if (price) out.clv = Math.round((pickOdds / price - 1) * 1000) / 10;
  if (fairProb) out.evClose = Math.round((pickOdds * fairProb - 1) * 1000) / 10;
  return Object.keys(out).length ? out : null;
}

async function computeAndSaveStats() {
  const snap = await db
    .collection("matches")
    .where("result", "in", ["won", "lost", "push"])
    .get();

  let totalPicks = 0;
  let wins = 0;
  let pushes = 0;
  let totalProfit = 0;
  let clvSum = 0;
  let clvCount = 0;
  const byPickType = {};

  for (const doc of snap.docs) {
    const m = doc.data();
    if (!m.pick) continue;
    if (typeof m.clv === "number") {
      clvSum += m.clv;
      clvCount++;
    }
    // Pushes return the stake: counted separately, excluded from win
    // rate and P&L (which cover decided bets only).
    if (m.result === "push") {
      pushes++;
      continue;
    }
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
    pushes,
    winRate:
      totalPicks > 0 ? Math.round((wins / totalPicks) * 1000) / 10 : 0,
    totalStake,
    totalProfit: Math.round(totalProfit),
    roi:
      totalStake > 0
        ? Math.round((totalProfit / totalStake) * 1000) / 10
        : 0,
    avgClv: clvCount > 0 ? Math.round((clvSum / clvCount) * 10) / 10 : null,
    clvCount,
    byPickType,
  };

  await db.collection("stats").doc("summary").set(stats);
  console.log(
    `[stats] picks=${totalPicks} wins=${wins} winRate=${stats.winRate}% ROI=${stats.roi}%`
  );
  return stats;
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
    const update = {
      finalScore: f.score,
      actualWinner: f.winner,
      result: resultLabel(won),
      resultRecordedAt: Timestamp.now(),
      status: "FINISHED",
    };
    const clvFields = computeClvFields(m);
    if (clvFields) Object.assign(update, clvFields);
    await ref.update(update);
    updated++;
  }

  console.log(`[results] updated ${updated} match docs`);
  const stats = await computeAndSaveStats();
  return { fetched: finished.length, updated, stats };
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

// Manual HTTP trigger for collecting results
export const collectResultsManual = onRequest(
  { invoker: "public", timeoutSeconds: 120 },
  async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const summary = await runCollectResults();
      res.json({ ok: true, ...summary });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

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
