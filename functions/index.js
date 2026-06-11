import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getUpcomingMatches, getFinishedMatches } from "./footballData.js";
import { getBetmanEplOdds, findBetmanFixture } from "./betman.js";

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

// EPL seasons run Aug–May: a July+ kickoff belongs to the season starting
// that year, otherwise to the season that started the previous year.
function seasonOf(kickoff) {
  const d = kickoff?.toDate ? kickoff.toDate() : null;
  if (!d) return "unknown";
  const y = d.getUTCFullYear();
  const startYear = d.getUTCMonth() >= 6 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

function newStatsBucket() {
  return { totalPicks: 0, wins: 0, pushes: 0, totalProfit: 0, clvSum: 0, clvCount: 0, byPickType: {} };
}

function addToStatsBucket(b, m, pickOdds) {
  if (typeof m.clv === "number") {
    b.clvSum += m.clv;
    b.clvCount++;
  }
  // Pushes return the stake: counted separately, excluded from win
  // rate and P&L (which cover decided bets only).
  if (m.result === "push") {
    b.pushes++;
    return;
  }
  b.totalPicks++;
  b.byPickType[m.pick] = b.byPickType[m.pick] || { count: 0, wins: 0 };
  b.byPickType[m.pick].count++;
  if (m.result === "won") {
    b.wins++;
    b.totalProfit += FLAT_STAKE * (pickOdds - 1);
    b.byPickType[m.pick].wins++;
  } else {
    b.totalProfit -= FLAT_STAKE;
  }
}

function finalizeStatsBucket(b) {
  const totalStake = b.totalPicks * FLAT_STAKE;
  return {
    totalPicks: b.totalPicks,
    wins: b.wins,
    losses: b.totalPicks - b.wins,
    pushes: b.pushes,
    winRate: b.totalPicks > 0 ? Math.round((b.wins / b.totalPicks) * 1000) / 10 : 0,
    totalStake,
    totalProfit: Math.round(b.totalProfit),
    roi: totalStake > 0 ? Math.round((b.totalProfit / totalStake) * 1000) / 10 : 0,
    avgClv: b.clvCount > 0 ? Math.round((b.clvSum / b.clvCount) * 10) / 10 : null,
    clvCount: b.clvCount,
    byPickType: b.byPickType,
  };
}

async function computeAndSaveStats() {
  const snap = await db
    .collection("matches")
    .where("result", "in", ["won", "lost", "push"])
    .get();

  const overall = newStatsBucket();
  const seasons = {};

  for (const doc of snap.docs) {
    const m = doc.data();
    if (!m.pick) continue;
    const pickOdds = getOddsForPick(m);
    if (!pickOdds && m.result !== "push") continue;

    addToStatsBucket(overall, m, pickOdds);
    const season = seasonOf(m.kickoff);
    seasons[season] = seasons[season] || newStatsBucket();
    addToStatsBucket(seasons[season], m, pickOdds);
  }

  const bySeason = {};
  for (const [season, bucket] of Object.entries(seasons)) {
    bySeason[season] = finalizeStatsBucket(bucket);
  }

  // Top-level fields stay all-time (legacy shape); per-season lives in
  // bySeason and the frontend headlines the current season.
  const stats = {
    updatedAt: Timestamp.now(),
    ...finalizeStatsBucket(overall),
    bySeason,
  };

  await db.collection("stats").doc("summary").set(stats);
  console.log(
    `[stats] picks=${stats.totalPicks} wins=${stats.wins} winRate=${stats.winRate}% ROI=${stats.roi}% avgClv=${stats.avgClv} seasons=${Object.keys(bySeason).join(",")}`
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

// Pull Betman (스포츠토토 프로토) fixed odds + per-match sale deadlines and
// attach them to upcoming match docs. Runs from Seoul (asia-northeast3)
// deliberately — Betman may reject non-KR source IPs, which rules out
// the GitHub Actions worker.
async function runCollectBetmanOdds() {
  let fixtures, diagnostics;
  try {
    ({ fixtures, diagnostics } = await getBetmanEplOdds());
  } catch (err) {
    // Publicly-readable heartbeat (stats/betman) so Betman access health
    // is observable without Functions-log access — KR-IP geo behaviour
    // in particular.
    await db.collection("stats").doc("betman").set({
      updatedAt: Timestamp.now(),
      ok: false,
      error: String(err.message).slice(0, 300),
    });
    throw err;
  }
  console.log(
    `[betman] rounds=${diagnostics.rounds.join(",") || "none"} eplFixtures=${fixtures.length} soccerLeagues=${diagnostics.soccerLeagues.join("|") || "none"}`
  );
  const heartbeat = {
    updatedAt: Timestamp.now(),
    ok: true,
    rounds: diagnostics.rounds,
    soccerLeagues: diagnostics.soccerLeagues,
    eplFixtures: fixtures.length,
  };
  if (!fixtures.length) {
    await db.collection("stats").doc("betman").set({ ...heartbeat, matched: 0 });
    return { matched: 0, total: 0, rounds: diagnostics.rounds };
  }

  const now = Date.now();
  const snap = await db
    .collection("matches")
    .where("kickoff", ">=", Timestamp.fromMillis(now - 3 * 3600_000))
    .where("kickoff", "<=", Timestamp.fromMillis(now + 8 * 24 * 3600_000))
    .get();

  let matched = 0;
  const matchedBetmanKeys = new Set();
  for (const doc of snap.docs) {
    const m = doc.data();
    const fx = findBetmanFixture(fixtures, m.home, m.away, m.kickoff.toMillis());
    if (!fx) continue;
    matchedBetmanKeys.add(`${fx.homeName}|${fx.awayName}|${fx.gameDate}`);
    await doc.ref.update({
      betman: {
        updatedAt: Timestamp.now(),
        round: fx.round ?? null,
        deadline: fx.deadline ? Timestamp.fromMillis(fx.deadline) : null,
        matchWinner: fx.matchWinner,
        overUnder: fx.overUnder,
      },
    });
    matched++;
  }

  // Unmatched Betman EPL fixtures = KR_TEAM_NAMES mapping gaps; these
  // logs are how the table gets corrected when the season starts.
  for (const fx of fixtures) {
    if (!matchedBetmanKeys.has(`${fx.homeName}|${fx.awayName}|${fx.gameDate}`)) {
      console.log(
        `[betman] UNMATCHED: ${fx.homeName} vs ${fx.awayName} @${new Date(fx.gameDate).toISOString()} — check KR_TEAM_NAMES in betman.js`
      );
    }
  }
  console.log(`[betman] matched ${matched}/${fixtures.length} Betman EPL fixtures to match docs`);
  await db.collection("stats").doc("betman").set({ ...heartbeat, matched });
  return { matched, total: fixtures.length, rounds: diagnostics.rounds };
}

// Daily 11:30 KST — 30 min before the analysis worker, so picks can carry
// Betman prices and deadlines. (Seoul-IP access to Betman verified live
// 2026-06-12: stats/betman heartbeat ok:true.)
export const collectBetmanOdds = onSchedule(
  { schedule: "30 11 * * *", timeZone: "Asia/Seoul", timeoutSeconds: 120 },
  runCollectBetmanOdds
);

export const collectBetmanOddsManual = onRequest(
  { invoker: "public", timeoutSeconds: 120 },
  async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const summary = await runCollectBetmanOdds();
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
    const fmtKst = (ts) => {
      const d = ts?.toDate ? ts.toDate() : new Date(ts);
      return d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    };
    const pickLines = picks.map((p, i) => {
      const dateStr = fmtKst(p.kickoff);
      const label = p.pickLabel || PICK_LABEL_KR[p.pick] || p.pick;
      let betmanLine;
      if (p.betmanOdds != null) {
        const evStr = p.betmanEv != null ? ` (EV ${p.betmanEv >= 0 ? "+" : ""}${p.betmanEv}%)` : "";
        const warn = p.betmanEv != null && p.betmanEv < 0 ? " ⚠️ 배당 부족 — 스킵 권장" : "";
        const deadline = p.betmanDeadline ? ` · 마감 ${fmtKst(p.betmanDeadline)}` : "";
        betmanLine = `\n   Betman @${p.betmanOdds}${evStr}${warn}${deadline}`;
      } else {
        betmanLine = p.minOdds != null ? `\n   최소 베팅 배당 ${p.minOdds} (이 미만이면 스킵)` : "";
      }
      return `${i + 1}. <b>${p.home} vs ${p.away}</b> (${dateStr})\n   ${label} @${p.odds} · Edge +${p.edge}% · EV +${p.ev}%${betmanLine}`;
    }).join("\n\n");

    const acca = after.comboOdds
      ? `\n\n🎲 어큐뮬레이터: <b>${after.comboOdds}x</b> (£10 → £${(10 * after.comboOdds).toFixed(2)})`
      : "";

    const msg = `⚽ <b>TotoLab — 새 값 픽 ${picks.length}개</b>\n\n${pickLines}${acca}`;
    await sendTelegram(msg);
  }
);
