const BASE_URL = "https://api.the-odds-api.com/v4";

function normalize(name) {
  return name
    .toLowerCase()
    .replace(/\s+(fc|afc)$/i, "")
    .replace(/\s+and\s+/gi, " & ")
    .trim();
}

export async function getEPLOdds() {
  const url =
    `${BASE_URL}/sports/soccer_epl/odds?apiKey=${process.env.ODDS_API_KEY}` +
    `&regions=eu&markets=h2h,totals&oddsFormat=decimal`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`the-odds-api ${res.status}: ${await res.text()}`);
  }

  const remaining = res.headers.get("x-requests-remaining");
  const used = res.headers.get("x-requests-used");
  console.log(`[odds-api] remaining=${remaining} used=${used}`);

  return res.json();
}

export function findOddsForMatch(oddsEvents, homeTeamName, awayTeamName) {
  const home = normalize(homeTeamName);
  const away = normalize(awayTeamName);

  const event = oddsEvents.find(
    (e) =>
      normalize(e.home_team) === home && normalize(e.away_team) === away
  );
  if (!event) return null;

  // Prefer Bet365 if available, else first bookmaker
  const bookmaker =
    event.bookmakers.find((b) => b.key === "bet365") || event.bookmakers[0];
  if (!bookmaker) return null;

  const result = { bookmaker: bookmaker.title };

  const h2h = bookmaker.markets.find((m) => m.key === "h2h");
  if (h2h) {
    result.matchWinner = {
      home: h2h.outcomes.find((o) => o.name === event.home_team)?.price ?? null,
      draw: h2h.outcomes.find((o) => o.name === "Draw")?.price ?? null,
      away: h2h.outcomes.find((o) => o.name === event.away_team)?.price ?? null,
    };
  }

  const totals = bookmaker.markets.find((m) => m.key === "totals");
  if (totals) {
    const lineMap = {};
    for (const o of totals.outcomes) {
      lineMap[o.point] = lineMap[o.point] || {};
      lineMap[o.point][o.name] = o.price;
    }
    let best = null;
    for (const [point, sides] of Object.entries(lineMap)) {
      if (!sides.Over || !sides.Under) continue;
      const diff = Math.abs(sides.Over - sides.Under);
      if (!best || diff < best.diff) {
        best = { line: parseFloat(point), over: sides.Over, under: sides.Under, diff };
      }
    }
    if (best) {
      result.overUnder = { line: best.line, over: best.over, under: best.under };
    }
  }

  return result;
}
