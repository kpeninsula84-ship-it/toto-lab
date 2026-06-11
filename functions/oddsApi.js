const BASE_URL = "https://api.the-odds-api.com/v4";

function normalize(name) {
  return name
    .toLowerCase()
    .replace(/^afc\s+/i, "")           // leading "AFC Bournemouth" → "bournemouth"
    .replace(/\s+(fc|afc)$/i, "")      // trailing FC/AFC suffix
    .replace(/\s+and\s+/gi, " & ")
    .trim();
}

// Quota note: cost per call = regions × markets. eu (Pinnacle) + uk
// (bet365/Smarkets/Betfair) and h2h + totals are all the engine uses —
// 4 credits/call. spreads and the us region were dead weight on the
// free 500/month tier.
export async function getEPLOdds() {
  const url =
    `${BASE_URL}/sports/soccer_epl/odds?apiKey=${process.env.ODDS_API_KEY}` +
    `&regions=eu,uk&markets=h2h,totals&oddsFormat=decimal`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`the-odds-api ${res.status}: ${await res.text()}`);
  }

  const remaining = res.headers.get("x-requests-remaining");
  const used = res.headers.get("x-requests-used");
  console.log(`[odds-api] remaining=${remaining} used=${used}`);

  return res.json();
}

function pickBookmaker(event, key) {
  return event.bookmakers.find((b) => b.key === key) || null;
}

function extractMatchWinner(bookmaker, event) {
  const h2h = bookmaker.markets.find((m) => m.key === "h2h");
  if (!h2h) return null;
  return {
    home: h2h.outcomes.find((o) => o.name === event.home_team)?.price ?? null,
    draw: h2h.outcomes.find((o) => o.name === "Draw")?.price ?? null,
    away: h2h.outcomes.find((o) => o.name === event.away_team)?.price ?? null,
  };
}

// Returns ALL totals lines as an array of {line, over, under}, sorted by
// |over-under| price gap ascending. The single most-balanced line stays
// available as `best` for backwards compatibility with the legacy schema.
function extractTotals(bookmaker) {
  const totals = bookmaker.markets.find((m) => m.key === "totals");
  if (!totals) return null;
  const lineMap = {};
  for (const o of totals.outcomes) {
    lineMap[o.point] = lineMap[o.point] || {};
    lineMap[o.point][o.name] = o.price;
  }
  const lines = [];
  for (const [point, sides] of Object.entries(lineMap)) {
    if (!sides.Over || !sides.Under) continue;
    lines.push({
      line: parseFloat(point),
      over: sides.Over,
      under: sides.Under,
      diff: Math.abs(sides.Over - sides.Under),
    });
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.diff - b.diff);
  const best = lines[0];
  return {
    best: { line: best.line, over: best.over, under: best.under },
    all: lines.map(({ diff, ...rest }) => rest),
  };
}

// Asian Handicap (a.k.a. spreads). The-odds-api uses outcome name = team name
// and `point` = handicap from that team's perspective. We pivot to home-side
// handicap convention so a value of -0.5 always means "home -0.5 / away +0.5".
function extractSpreads(bookmaker, event) {
  const spreads = bookmaker.markets.find((m) => m.key === "spreads");
  if (!spreads) return null;
  const lineMap = {};
  for (const o of spreads.outcomes) {
    const isHome = o.name === event.home_team;
    const homeLine = isHome ? o.point : -o.point;
    lineMap[homeLine] = lineMap[homeLine] || {};
    lineMap[homeLine][isHome ? "home" : "away"] = o.price;
  }
  const lines = [];
  for (const [homeLine, sides] of Object.entries(lineMap)) {
    if (!sides.home || !sides.away) continue;
    lines.push({
      line: parseFloat(homeLine),
      home: sides.home,
      away: sides.away,
      diff: Math.abs(sides.home - sides.away),
    });
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.diff - b.diff);
  const best = lines[0];
  return {
    best: { line: best.line, home: best.home, away: best.away },
    all: lines.map(({ diff, ...rest }) => rest),
  };
}

function extractTeamTotals(bookmaker, event) {
  const market = bookmaker.markets.find((m) => m.key === "team_totals");
  if (!market) return null;
  // Outcomes shape: { name: "Over"/"Under", description: <team name>, point, price }
  const byTeam = { home: {}, away: {} };
  for (const o of market.outcomes) {
    const teamSide =
      o.description === event.home_team
        ? "home"
        : o.description === event.away_team
          ? "away"
          : null;
    if (!teamSide) continue;
    const lineKey = String(o.point);
    byTeam[teamSide][lineKey] = byTeam[teamSide][lineKey] || {};
    byTeam[teamSide][lineKey][o.name] = o.price;
  }
  const sideLines = (sideMap) => {
    const lines = [];
    for (const [point, sides] of Object.entries(sideMap)) {
      if (!sides.Over || !sides.Under) continue;
      lines.push({
        line: parseFloat(point),
        over: sides.Over,
        under: sides.Under,
        diff: Math.abs(sides.Over - sides.Under),
      });
    }
    if (!lines.length) return null;
    lines.sort((a, b) => a.diff - b.diff);
    const best = lines[0];
    return {
      best: { line: best.line, over: best.over, under: best.under },
      all: lines.map(({ diff, ...rest }) => rest),
    };
  };
  const home = sideLines(byTeam.home);
  const away = sideLines(byTeam.away);
  if (!home && !away) return null;
  return { home, away };
}

function extractAll(bookmaker, event, teamTotalsBookmaker) {
  if (!bookmaker) return null;
  const out = {
    book: bookmaker.key,
    bookTitle: bookmaker.title,
    matchWinner: extractMatchWinner(bookmaker, event),
    totals: extractTotals(bookmaker),
    spreads: extractSpreads(bookmaker, event),
    teamTotals: teamTotalsBookmaker
      ? extractTeamTotals(teamTotalsBookmaker, event)
      : extractTeamTotals(bookmaker, event),
  };
  return out;
}

// Returns { fair, market, legacy } where:
//   fair    = Pinnacle (or first sharp fallback) snapshot — used as the
//             "true price" benchmark after de-vig.
//   market  = bet365 (or first available) snapshot — used as the actual
//             execution price for EV.
//   legacy  = flat shape kept for code that hasn't migrated yet
//             (bookmaker title + matchWinner + overUnder + ouLine).
//
// `teamTotalsEvents` is optional; when supplied, team_totals come from that
// feed (it lives on a separate sport key on the-odds-api).
export function findOddsForMatch(
  oddsEvents,
  homeTeamName,
  awayTeamName,
  teamTotalsEvents = null
) {
  const home = normalize(homeTeamName);
  const away = normalize(awayTeamName);

  const event = oddsEvents.find(
    (e) =>
      normalize(e.home_team) === home && normalize(e.away_team) === away
  );
  if (!event) return null;

  const teamTotalsEvent = teamTotalsEvents
    ? teamTotalsEvents.find(
        (e) =>
          normalize(e.home_team) === home &&
          normalize(e.away_team) === away
      )
    : null;

  const SHARP_BOOKS = ["pinnacle", "smarkets", "betfair_ex_eu", "betfair"];
  let sharpBook = null;
  for (const key of SHARP_BOOKS) {
    sharpBook = pickBookmaker(event, key);
    if (sharpBook) break;
  }

  const marketBook =
    pickBookmaker(event, "bet365") || event.bookmakers[0] || null;
  if (!sharpBook && !marketBook) return null;

  const sharpTtBook = teamTotalsEvent
    ? SHARP_BOOKS.map((k) => pickBookmaker(teamTotalsEvent, k)).find(Boolean) ||
      null
    : null;
  const marketTtBook = teamTotalsEvent
    ? pickBookmaker(teamTotalsEvent, "bet365") ||
      teamTotalsEvent.bookmakers[0] ||
      null
    : null;

  const fair = extractAll(sharpBook, event, sharpTtBook);
  const market = extractAll(marketBook, event, marketTtBook);

  // Legacy shape: keep callers that read `result.matchWinner` / `result.overUnder`
  // working until the EV pipeline migrates. Prefers `market` (bet365) so the
  // execution price stays unchanged for users mid-migration.
  const legacySource = market || fair;
  const legacy = {
    bookmaker: legacySource?.bookTitle ?? null,
    matchWinner: legacySource?.matchWinner ?? null,
    overUnder: legacySource?.totals?.best ?? null,
  };

  return { fair, market, ...legacy };
}
