// Unit tests for the market-anchored post-processing math (engine v2).
// Run: node --test worker/v2math.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMarketAnchoredDeltas,
  sanitizeDeltas,
  roundToHundred,
  scheduleFacts,
  medianDeltas,
  maxDeltaGap,
  MAX_MW_DELTA,
  DRAW_FLOOR_SLACK,
} from "./analyzer.js";

const FAIR = {
  matchWinner: { home: 0.4, draw: 0.27, away: 0.33 },
  overUnder: { line: 2.5, over: 0.52, under: 0.48 },
};

function sum(o) {
  return Object.values(o).reduce((a, b) => a + b, 0);
}

test("zero deltas reproduce the baseline exactly", () => {
  const { probs, probsExact, overUnder, violations } = applyMarketAnchoredDeltas(FAIR, {});
  assert.equal(sum(probs), 100);
  assert.equal(probs.home, 40);
  assert.equal(probs.draw, 27);
  assert.equal(probs.away, 33);
  assert.ok(Math.abs(probsExact.home - 40) < 1e-9);
  assert.equal(overUnder.over, 52);
  assert.equal(violations.length, 0);
});

test("sum-zero mass shift passes through undiluted", () => {
  const { probsExact } = applyMarketAnchoredDeltas(FAIR, { home: 7, away: -7 });
  assert.ok(Math.abs(probsExact.home - 47) < 1e-9, `home=${probsExact.home}`);
  assert.ok(Math.abs(probsExact.away - 26) < 1e-9);
  assert.ok(Math.abs(sum(probsExact) - 100) < 1e-9);
});

test("out-of-range deltas are ZEROED (not clamped) and flagged", () => {
  const { probsExact, violations } = applyMarketAnchoredDeltas(FAIR, { home: 30, away: -30 });
  // both zeroed → pure baseline, with violations recorded
  assert.ok(Math.abs(probsExact.home - 40) < 1e-9, `home=${probsExact.home}`);
  assert.equal(violations.length, 2);
});

test("non-sum-zero 1X2 deltas are re-centered", () => {
  // one-sided +6 → re-centered to +4/-2/-2: no free edge from a lone delta
  const { deltas } = sanitizeDeltas({ home: 6 });
  assert.ok(Math.abs(deltas.home - 4) < 1e-9);
  assert.ok(Math.abs(deltas.draw - -2) < 1e-9);
  assert.ok(Math.abs(deltas.away - -2) < 1e-9);
  const { probsExact } = applyMarketAnchoredDeltas(FAIR, { home: 6 });
  assert.ok(Math.abs(probsExact.home - 44) < 0.5, `home=${probsExact.home}`);
});

test("draw floor holds even after normalization pressure", () => {
  // draw -7 floored at base-2; deficit must not leak back through scaling
  const fair = { matchWinner: { home: 0.3, draw: 0.25, away: 0.45 } };
  const { probsExact } = applyMarketAnchoredDeltas(fair, { home: 2, draw: -7, away: 5 });
  const floor = 25 - DRAW_FLOOR_SLACK;
  assert.ok(probsExact.draw >= floor - 1e-9, `draw=${probsExact.draw} < floor ${floor}`);
  assert.ok(Math.abs(sum(probsExact) - 100) < 1e-9);
});

test("over/under mirror and clamp", () => {
  const { overUnderExact } = applyMarketAnchoredDeltas(FAIR, { over: -6 });
  assert.ok(Math.abs(overUnderExact.over - 46) < 1e-9);
  assert.ok(Math.abs(overUnderExact.under - 54) < 1e-9);
  const zeroed = applyMarketAnchoredDeltas(FAIR, { over: -20 });
  assert.ok(Math.abs(zeroed.overUnderExact.over - 52) < 1e-9); // zeroed, not clamped
  assert.equal(zeroed.violations.length, 1);
});

test("non-numeric deltas are treated as 0", () => {
  const { probsExact, overUnderExact, violations } = applyMarketAnchoredDeltas(FAIR, {
    home: "lots",
    draw: null,
    over: undefined,
  });
  assert.ok(Math.abs(probsExact.home - 40) < 1e-9);
  assert.ok(Math.abs(overUnderExact.over - 52) < 1e-9);
  assert.equal(violations.length, 0);
});

test("missing market sections yield nulls, not throws", () => {
  const onlyMw = applyMarketAnchoredDeltas({ matchWinner: FAIR.matchWinner }, { home: 3, away: -3 });
  assert.equal(onlyMw.overUnder, null);
  assert.equal(sum(onlyMw.probs), 100);
  const onlyOu = applyMarketAnchoredDeltas({ overUnder: FAIR.overUnder }, { over: 3 });
  assert.equal(onlyOu.probs, null);
  assert.ok(Math.abs(onlyOu.overUnderExact.over - 55) < 1e-9);
});

test("max compliant delta yields a pick-eligible edge (>= 5)", () => {
  // +7/-5/-2 sums to 0; home edge must be exactly +7 on exact probs
  const { probsExact } = applyMarketAnchoredDeltas(FAIR, { home: 7, draw: -5, away: -2 });
  const edge = probsExact.home - FAIR.matchWinner.home * 100;
  assert.ok(edge >= 5, `edge=${edge}`);
});

test("roundToHundred preserves sum under awkward fractions", () => {
  const r = roundToHundred({ a: 33.4, b: 33.3, c: 33.3 });
  assert.equal(sum(r), 100);
  const r2 = roundToHundred({ a: 49.5, b: 50.5 });
  assert.equal(sum(r2), 100);
});

test("extreme baseline (heavy favourite) stays sane", () => {
  const fair = { matchWinner: { home: 0.82, draw: 0.12, away: 0.06 } };
  const { probsExact } = applyMarketAnchoredDeltas(fair, { home: -7, away: 7 });
  assert.ok(Math.abs(sum(probsExact) - 100) < 1e-9);
  assert.ok(probsExact.away >= 2 && probsExact.home >= 2);
});

test("scheduleFacts computes rest and congestion", () => {
  const ko = "2026-08-22T16:30:00Z";
  const recent = [
    { date: "2026-08-19T19:00:00Z", competition: "UEFA Champions League" },
    { date: "2026-08-15T14:00:00Z", competition: "Premier League" },
    { date: "2026-07-30T14:00:00Z", competition: "Friendly" },
  ];
  const upcoming = [
    { date: "2026-08-22T16:30:00Z", competition: "Premier League" }, // the match itself
    { date: "2026-08-26T19:00:00Z", competition: "UEFA Champions League" },
  ];
  const f = scheduleFacts(recent, upcoming, ko);
  assert.ok(Math.abs(f.daysSinceLastMatch - 2.9) < 0.2, `rest=${f.daysSinceLastMatch}`);
  assert.equal(f.lastMatchCompetition, "UEFA Champions League");
  assert.equal(f.matchesInLast14Days, 2);
  assert.ok(f.daysToNextMatch > 3.5 && f.daysToNextMatch < 4.5);
  assert.equal(f.nextMatchCompetition, "UEFA Champions League");
});

test("maxDeltaGap finds the largest per-key disagreement", () => {
  const a = { home: 3, draw: 0, away: -3, over: 2 };
  const b = { home: 1, draw: -1, away: 0, over: 6 };
  assert.equal(maxDeltaGap(a, b), 4); // over: |2-6|
  assert.equal(maxDeltaGap(a, a), 0);
  assert.equal(maxDeltaGap({}, { home: 5 }), 5); // missing keys read as 0
});

test("medianDeltas: median of 2 is the mean, median of 3 is the middle", () => {
  const two = medianDeltas([{ home: 4, draw: 0, away: -4, over: 0 }, { home: 2, draw: 0, away: -2, over: 2 }]);
  assert.equal(two.home, 3);
  assert.equal(two.over, 1);
  const three = medianDeltas([
    { home: 7, draw: 0, away: -7, over: 0 },
    { home: 1, draw: 0, away: -1, over: 0 },
    { home: 2, draw: 0, away: -2, over: 0 },
  ]);
  assert.equal(three.home, 2); // outlier +7 neutralized
  assert.equal(three.away, -2);
});

test("scheduleFacts tolerates empty inputs", () => {
  const f = scheduleFacts([], [], "2026-08-22T16:30:00Z");
  assert.equal(f.daysSinceLastMatch, null);
  assert.equal(f.matchesInLast14Days, 0);
  assert.equal(f.daysToNextMatch, null);
});
