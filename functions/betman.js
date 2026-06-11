// Betman (betman.co.kr — Korean Sports Toto "Proto" fixed-odds) client.
//
// Reverse-engineered from the site's own XHR layer (requestClient.js):
// unauthenticated JSON POSTs with a `_sbmInfo` envelope. Two endpoints:
//   /buyPsblGame/lotterySchedulesInq.do  → round (회차) list + sale status
//   /buyPsblGame/gameInfoInq.do          → per-round games with odds and
//                                          per-match sale deadline (endDate)
//
// NOT an official API — if Betman redesigns, this breaks loudly (the
// scheduled function's failure shows up in Functions logs; downstream
// consumers treat missing betman data as "not available", never fatal).
//
// Runs from Cloud Functions in asia-northeast3 (Seoul) on purpose:
// Betman may reject non-KR source IPs, which rules out GitHub Actions.

const BASE_URL = "https://www.betman.co.kr";
const GM_ID = "G101"; // 프로토 승부식

// Betman's TLS stack is legacy (renegotiation-happy) and intermittently
// drops connections (ECONNRESET) — retry with a short backoff.
async function betmanPost(path, params, retries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          Referer: `${BASE_URL}/main/mainPage/gamebuy/gameSlip.do?gmId=${GM_ID}`,
        },
        body: JSON.stringify({ ...params, _sbmInfo: { debugMode: "false" } }),
      });
      if (!res.ok) {
        throw new Error(`betman ${path} HTTP ${res.status}`);
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`betman ${path} returned non-JSON (${text.slice(0, 120)})`);
      }
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        console.log(`[betman] ${path} attempt ${attempt} failed (${err.message}) — retrying`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  throw lastErr;
}

export async function fetchBetmanRounds() {
  const data = await betmanPost("/buyPsblGame/lotterySchedulesInq.do", { gmId: GM_ID });
  return data.lotterySchedulesList || [];
}

// compSchedules comes as parallel keys/datas arrays — zip into objects.
function decodeRows(compSchedules) {
  const keys = compSchedules?.keys || [];
  return (compSchedules?.datas || []).map((row) => {
    const o = {};
    keys.forEach((k, i) => (o[k] = row[i]));
    return o;
  });
}

export async function fetchRoundGames(gmTs, gameYear) {
  const data = await betmanPost("/buyPsblGame/gameInfoInq.do", {
    gmId: GM_ID,
    gmTs: String(gmTs),
    gameYear: String(gameYear ?? ""),
  });
  return decodeRows(data.compSchedules);
}

// ── EPL extraction ───────────────────────────────────────────────────────────

function isEplRow(row) {
  if (row.itemCode !== "SC") return false;
  const league = `${row.leagueName ?? ""} ${row.leagueShortName ?? ""}`;
  return /프리미어|EPL/i.test(league) && /잉글|프리미어/.test(league);
}

// Each fixture appears as several rows (one per bet type). Verified
// against live data: handi is a bet-type CODE (0=승무패, 2=핸디캡,
// 9=언더오버), the actual U/O line lives in winHandi, and betNm carries
// a clean type name ("축구 언더오버", "축구 핸디캡").
function classifyRow(row) {
  const betNm = String(row.betNm ?? "");
  const betTypNm = String(row.betTypNm ?? "");
  if (betNm.includes("전반") || betTypNm.includes("전반")) return "other"; // half-time markets
  if (betNm.includes("언더오버")) return "overUnder";
  if (betNm.includes("핸디캡")) return "other";
  const w = String(row.winTxt ?? "");
  if (w.includes("언더") || w.includes("오버")) return "overUnder";
  if (w === "승" && Number(row.drawAllot) > 0 && (!row.handi || Number(row.handi) === 0)) {
    return "matchWinner";
  }
  return "other"; // odd/even, grand salami, etc.
}

// Group raw rows into one record per fixture with the markets we use.
// `filter` is injectable for diagnostics/tests; production uses isEplRow.
export function groupEplFixtures(rows, filter = isEplRow) {
  const fixtures = new Map();
  for (const row of rows) {
    if (!filter(row)) continue;
    const key = `${row.homeName}|${row.awayName}|${row.gameDate}`;
    if (!fixtures.has(key)) {
      fixtures.set(key, {
        homeName: row.homeName,
        awayName: row.awayName,
        gameDate: row.gameDate, // epoch ms (KST wall-clock based)
        deadline: row.endDate ?? null, // per-match sale deadline, epoch ms
        leagueName: row.leagueName,
        matchWinner: null,
        overUnder: [],
      });
    }
    const fx = fixtures.get(key);
    if (row.endDate && (!fx.deadline || row.endDate < fx.deadline)) fx.deadline = row.endDate;

    const type = classifyRow(row);
    if (type === "matchWinner" && !fx.matchWinner) {
      fx.matchWinner = {
        home: Number(row.winAllot) || null,
        draw: Number(row.drawAllot) || null,
        away: Number(row.loseAllot) || null,
        matchSeq: row.matchSeq,
      };
    } else if (type === "overUnder") {
      const line = Number(row.winHandi); // U/O line (e.g. 2.5); handi is a type code
      if (!Number.isFinite(line) || line <= 0) continue;
      const winIsUnder = String(row.winTxt).includes("언더");
      fx.overUnder.push({
        line,
        over: Number(winIsUnder ? row.loseAllot : row.winAllot) || null,
        under: Number(winIsUnder ? row.winAllot : row.loseAllot) || null,
        matchSeq: row.matchSeq,
      });
    }
  }
  return [...fixtures.values()];
}

// All EPL fixtures across currently-sellable rounds. Later rounds
// overwrite earlier ones for the same fixture (fresher odds).
export async function getBetmanEplOdds() {
  const rounds = (await fetchBetmanRounds()).filter((r) =>
    ["SaleProgress", "SaleReady", "SaleBefore"].includes(r.saleStatus)
  );
  const byFixture = new Map();
  const diagnostics = { rounds: rounds.map((r) => r.gmTs), soccerLeagues: new Set(), eplRows: 0 };

  for (const round of rounds.sort((a, b) => a.gmTs - b.gmTs)) {
    let rows;
    try {
      rows = await fetchRoundGames(round.gmTs, round.gmOsidTsYear);
    } catch (err) {
      console.error(`[betman] round ${round.gmTs} fetch failed: ${err.message}`);
      continue;
    }
    for (const r of rows) {
      if (r.itemCode === "SC" && r.leagueName) diagnostics.soccerLeagues.add(r.leagueName);
    }
    for (const fx of groupEplFixtures(rows)) {
      diagnostics.eplRows++;
      byFixture.set(`${fx.homeName}|${fx.awayName}|${fx.gameDate}`, { ...fx, round: round.gmTs });
    }
  }

  return {
    fixtures: [...byFixture.values()],
    diagnostics: { ...diagnostics, soccerLeagues: [...diagnostics.soccerLeagues] },
  };
}

// ── Team name matching (football-data.org EN → Betman KR) ───────────────────
//
// Betman's exact Korean spellings can't be confirmed until an EPL round
// goes on sale (Aug); variants below are best-effort. Unmatched fixtures
// are logged so the table can be corrected from real data.

const KR_TEAM_NAMES = {
  "Arsenal FC": ["아스널", "아스날"],
  "Aston Villa FC": ["애스턴빌라", "아스톤빌라", "애스턴 빌라", "A빌라"],
  "AFC Bournemouth": ["본머스", "본머쓰", "보머스"],
  "Brentford FC": ["브렌트퍼드", "브렌트포드", "브랜트퍼드"],
  "Brighton & Hove Albion FC": ["브라이턴", "브라이튼"],
  "Burnley FC": ["번리", "번리FC"],
  "Chelsea FC": ["첼시"],
  "Crystal Palace FC": ["크리스탈팰리스", "크리스털팰리스", "크리스탈펠리스", "C팰리스"],
  "Everton FC": ["에버턴", "에버튼"],
  "Fulham FC": ["풀럼", "풀햄", "풀럼FC"],
  "Leeds United FC": ["리즈", "리즈유나이티드", "리즈Utd"],
  "Liverpool FC": ["리버풀"],
  "Manchester City FC": ["맨체스터시티", "맨시티", "맨체스터C"],
  "Manchester United FC": ["맨체스터유나이티드", "맨유", "맨체스터Utd", "맨체스터U"],
  "Newcastle United FC": ["뉴캐슬", "뉴캐슬유나이티드"],
  "Nottingham Forest FC": ["노팅엄", "노팅험", "노팅엄포레스트", "노팅엄F"],
  "Sunderland AFC": ["선덜랜드", "선더랜드"],
  "Tottenham Hotspur FC": ["토트넘", "토트넘홋스퍼"],
  "West Ham United FC": ["웨스트햄", "웨스트햄유나이티드"],
  "Wolverhampton Wanderers FC": ["울버햄프턴", "울버햄튼", "울브스", "울버햄프톤"],
};

function normalizeKr(name) {
  return String(name ?? "").replace(/\s+/g, "");
}

export function matchesKrName(enName, krName) {
  const variants = KR_TEAM_NAMES[enName];
  const kr = normalizeKr(krName);
  if (!kr) return false;
  if (!variants) return false;
  return variants.some((v) => kr.startsWith(normalizeKr(v)) || normalizeKr(v).startsWith(kr));
}

// Find the Betman fixture for one of our match docs (EN names + kickoff
// Timestamp millis). Kickoff must agree within 3h to avoid pairing the
// reverse fixture or a rescheduled match.
export function findBetmanFixture(fixtures, home, away, kickoffMillis) {
  return (
    fixtures.find(
      (fx) =>
        matchesKrName(home, fx.homeName) &&
        matchesKrName(away, fx.awayName) &&
        Math.abs(fx.gameDate - kickoffMillis) <= 3 * 3_600_000
    ) ?? null
  );
}

// ── Diagnostics CLI: `node betman.js` hits the live API ─────────────────────
// NOTE: must stay free of top-level await — the firebase-functions loader
// require()s this module's importer, and require() cannot load an ESM
// graph that contains TLA (ERR_REQUIRE_ASYNC_MODULE breaks deploys).

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  (async () => {
    const { fixtures, diagnostics } = await getBetmanEplOdds();
    console.log("on-sale rounds:", diagnostics.rounds.join(", ") || "(none)");
    console.log("soccer leagues on sale:", diagnostics.soccerLeagues.join(" | ") || "(none)");
    console.log(`EPL fixtures found: ${fixtures.length}`);
    for (const fx of fixtures.slice(0, 10)) {
      console.log(
        `  ${fx.homeName} vs ${fx.awayName} @${new Date(fx.gameDate).toISOString()} ` +
          `마감 ${fx.deadline ? new Date(fx.deadline).toISOString() : "?"} ` +
          `1X2=${JSON.stringify(fx.matchWinner)} OU=${JSON.stringify(fx.overUnder)}`
      );
    }
  })().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
}
