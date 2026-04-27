import { test } from "node:test";
import assert from "node:assert/strict";
import { findOddsForMatch } from "./oddsApi.js";

// Minimal the-odds-api event shape for testing extract paths.
function event({
  home = "Arsenal FC",
  away = "Chelsea FC",
  bookmakers = [],
} = {}) {
  return {
    home_team: home,
    away_team: away,
    bookmakers,
  };
}

function bookmaker(key, title, markets) {
  return { key, title, markets };
}

test("findOddsForMatch picks Pinnacle as fair, bet365 as market", () => {
  const ev = event({
    bookmakers: [
      bookmaker("bet365", "Bet365", [
        {
          key: "h2h",
          outcomes: [
            { name: "Arsenal FC", price: 1.85 },
            { name: "Draw", price: 3.6 },
            { name: "Chelsea FC", price: 4.5 },
          ],
        },
      ]),
      bookmaker("pinnacle", "Pinnacle", [
        {
          key: "h2h",
          outcomes: [
            { name: "Arsenal FC", price: 1.95 },
            { name: "Draw", price: 3.7 },
            { name: "Chelsea FC", price: 4.6 },
          ],
        },
      ]),
    ],
  });

  const out = findOddsForMatch([ev], "Arsenal FC", "Chelsea FC");
  assert.equal(out.fair.book, "pinnacle");
  assert.equal(out.market.book, "bet365");
  // Legacy fields stay populated from market book
  assert.equal(out.matchWinner.home, 1.85);
  assert.equal(out.bookmaker, "Bet365");
});

test("findOddsForMatch falls back to first bookmaker when bet365 absent", () => {
  const ev = event({
    bookmakers: [
      bookmaker("williamhill", "William Hill", [
        {
          key: "h2h",
          outcomes: [
            { name: "Arsenal FC", price: 1.9 },
            { name: "Draw", price: 3.5 },
            { name: "Chelsea FC", price: 4.4 },
          ],
        },
      ]),
    ],
  });
  const out = findOddsForMatch([ev], "Arsenal FC", "Chelsea FC");
  assert.equal(out.market.book, "williamhill");
  assert.equal(out.fair, null);
});

test("totals best line is the most balanced", () => {
  const ev = event({
    bookmakers: [
      bookmaker("pinnacle", "Pinnacle", [
        {
          key: "totals",
          outcomes: [
            { name: "Over", point: 2.5, price: 1.95 },
            { name: "Under", point: 2.5, price: 1.95 },
            { name: "Over", point: 3.5, price: 3.2 },
            { name: "Under", point: 3.5, price: 1.35 },
          ],
        },
      ]),
    ],
  });
  const out = findOddsForMatch([ev], "Arsenal FC", "Chelsea FC");
  // 2.5 line is balanced (diff 0); 3.5 line is heavily skewed.
  assert.equal(out.fair.totals.best.line, 2.5);
  assert.equal(out.fair.totals.all.length, 2);
});

test("spreads pivots to home-side line convention", () => {
  const ev = event({
    bookmakers: [
      bookmaker("pinnacle", "Pinnacle", [
        {
          key: "spreads",
          outcomes: [
            { name: "Arsenal FC", point: -0.5, price: 1.9 },
            { name: "Chelsea FC", point: 0.5, price: 1.95 },
            { name: "Arsenal FC", point: -1.5, price: 3.2 },
            { name: "Chelsea FC", point: 1.5, price: 1.35 },
          ],
        },
      ]),
    ],
  });
  const out = findOddsForMatch([ev], "Arsenal FC", "Chelsea FC");
  // Home -0.5 favourite priced 1.9; away +0.5 priced 1.95
  const minus05 = out.fair.spreads.all.find((l) => l.line === -0.5);
  assert.ok(minus05);
  assert.equal(minus05.home, 1.9);
  assert.equal(minus05.away, 1.95);
});

test("missing match returns null", () => {
  const out = findOddsForMatch([], "Arsenal FC", "Chelsea FC");
  assert.equal(out, null);
});
