import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bookSum,
  overround,
  impliedProbs,
  devigProportional,
  devigPower,
  devigShin,
  devigMatchWinner,
  devigTwoWay,
} from "./devig.js";

const sumsToOne = (probs, tol = 1e-6) =>
  Math.abs(probs.reduce((a, b) => a + b, 0) - 1) < tol;

test("impliedProbs returns 1/odds", () => {
  const probs = impliedProbs([2.0, 4.0, 5.0]);
  assert.deepEqual(probs, [0.5, 0.25, 0.2]);
});

test("bookSum and overround match a known overround", () => {
  // 1X2 with ~4% overround (typical bet365 EPL price)
  const odds = [1.85, 3.6, 4.5];
  const sum = bookSum(odds);
  assert.ok(sum > 1.03 && sum < 1.05, `unexpected booksum ${sum}`);
  assert.ok(Math.abs(overround(odds) - (sum - 1)) < 1e-12);
});

test("devigProportional sums to 1", () => {
  const probs = devigProportional([1.85, 3.6, 4.5]);
  assert.ok(sumsToOne(probs));
});

test("devigPower sums to 1 within tolerance for typical 1X2", () => {
  const probs = devigPower([1.85, 3.6, 4.5]);
  assert.ok(sumsToOne(probs, 1e-7));
  // Sanity: favourite probability should still be largest
  assert.ok(probs[0] > probs[1] && probs[1] > probs[2]);
});

test("devigPower matches a near-zero-overround Pinnacle book closely", () => {
  // Pinnacle-style ~2% margin: 2.05 / 3.65 / 4.40
  const probs = devigPower([2.05, 3.65, 4.4]);
  assert.ok(sumsToOne(probs, 1e-7));
  // Favourite around ~48%
  assert.ok(probs[0] > 0.45 && probs[0] < 0.51);
});

test("devigShin sums to 1 for typical 1X2", () => {
  const probs = devigShin([1.85, 3.6, 4.5]);
  assert.ok(sumsToOne(probs, 1e-7));
});

test("power vs proportional: power gives favourite MORE weight (longshot-bias correction)", () => {
  // Heavy favourite market — bet365-style high overround
  const odds = [1.3, 5.5, 11.0];
  const power = devigPower(odds);
  const prop = devigProportional(odds);
  assert.ok(sumsToOne(power, 1e-7));
  assert.ok(sumsToOne(prop, 1e-7));
  // Power method corrects longshot bias by shaving more vig from the
  // longshot side, so favourite ends up at a HIGHER fair probability
  // than under the proportional method. This is why we prefer it.
  assert.ok(
    power[0] >= prop[0] - 1e-9,
    `power favourite ${power[0]} should be >= prop ${prop[0]}`
  );
  // And the longshot ends up LOWER under power.
  assert.ok(
    power[2] <= prop[2] + 1e-9,
    `power longshot ${power[2]} should be <= prop ${prop[2]}`
  );
});

test("devigMatchWinner shape", () => {
  const fair = devigMatchWinner({ home: 1.85, draw: 3.6, away: 4.5 });
  assert.ok(fair && typeof fair === "object");
  assert.ok(sumsToOne([fair.home, fair.draw, fair.away], 1e-7));
});

test("devigMatchWinner returns null when an outcome is missing", () => {
  assert.equal(devigMatchWinner({ home: 1.85, draw: null, away: 4.5 }), null);
});

test("devigTwoWay (over/under) sums to 1", () => {
  const probs = devigTwoWay(1.95, 1.95);
  assert.ok(probs && sumsToOne(probs, 1e-7));
  // Symmetric market → ~0.5/0.5
  assert.ok(Math.abs(probs[0] - 0.5) < 1e-6);
});

test("devigTwoWay handles asymmetric AH lines", () => {
  // Home -0.5 favourite priced 1.6, away +0.5 priced 2.4
  const probs = devigTwoWay(1.6, 2.4);
  assert.ok(probs && sumsToOne(probs, 1e-7));
  assert.ok(probs[0] > probs[1]);
});

test("devigPower throws on invalid odds", () => {
  assert.throws(() => devigPower([1.0, 2.0])); // odds must be > 1
  assert.throws(() => devigPower([2.0])); // need >= 2
});
