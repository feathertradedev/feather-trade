import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptAmount,
  assertNonMainnetEnvironment,
  assertWithinHardRange,
  buildHistoricalSchedule,
  chooseDirection,
  chooseGuardedDirection,
  chooseOrganicDirection,
  createSeededRandom,
  jitterIntervalMs,
  sampleTradeAmount,
  safeDirectionCandidates
} from "../src/index.js";

const range = { anchor: 100, hardRadius: 8, turnaroundRadius: 6 };

test("forces trade direction toward the anchor at turnaround boundaries", () => {
  assert.equal(chooseDirection(106, "usdc-to-weth", range), "weth-to-usdc");
  assert.equal(chooseDirection(94, "weth-to-usdc", range), "usdc-to-weth");
  assert.equal(chooseDirection(100, "usdc-to-weth", range), "usdc-to-weth");
  assert.equal(chooseGuardedDirection(95, "weth-to-usdc", range, { "weth-to-usdc": 3, "usdc-to-weth": 1 }), "usdc-to-weth");
  assert.equal(chooseGuardedDirection(105, "usdc-to-weth", range, { "weth-to-usdc": 1, "usdc-to-weth": 3 }), "weth-to-usdc");
  assert.deepEqual(safeDirectionCandidates(100, "weth-to-usdc", range, { "weth-to-usdc": 1, "usdc-to-weth": 1 }), ["weth-to-usdc", "usdc-to-weth"]);
  assert.deepEqual(safeDirectionCandidates(93, "weth-to-usdc", range, { "weth-to-usdc": 3, "usdc-to-weth": 1 }), ["usdc-to-weth"]);
  assert.doesNotThrow(() => assertWithinHardRange(108, range));
  assert.throws(() => assertWithinHardRange(109, range), /left hard range/);
});

test("adapts bounded amounts after repeated zero movement and multi-bin movement", () => {
  const initial = { amount: 100n, baseAmount: 100n, cap: 200n, unchangedTrades: 0 };
  const once = adaptAmount(initial, 0);
  assert.equal(once.amount, 100n);
  const twice = adaptAmount(once, 0);
  assert.equal(twice.amount, 125n);
  const capped = adaptAmount({ ...twice, amount: 190n }, 0);
  assert.equal(capped.amount, 200n);
  assert.equal(adaptAmount(capped, 2).amount, 133n);
});

test("seeded random sources are reproducible, bounded, and varied", () => {
  const first = createSeededRandom(0xdecafbad);
  const second = createSeededRandom(0xdecafbad);
  const values = Array.from({ length: 64 }, () => first());
  assert.deepEqual(values, Array.from({ length: 64 }, () => second()));
  assert(values.every((value) => value >= 0 && value < 1));
  assert(new Set(values).size > 60);

  const different = createSeededRandom(0xdecafbae);
  assert.notDeepEqual(values, Array.from({ length: 64 }, () => different()));
  assert.doesNotThrow(() => createSeededRandom(0));
  assert.doesNotThrow(() => createSeededRandom(0xffff_ffff));
  assert.throws(() => createSeededRandom(-1), /unsigned 32-bit integer/);
  assert.throws(() => createSeededRandom(0x1_0000_0000), /unsigned 32-bit integer/);
  assert.throws(() => createSeededRandom(1.5), /unsigned 32-bit integer/);
});

test("organic direction choices preserve runs while mean-reverting on both sides", () => {
  const centerRandom = createSeededRandom(117);
  let lastDirection: "weth-to-usdc" | "usdc-to-weth" = "weth-to-usdc";
  const directions = Array.from({ length: 300 }, () => {
    lastDirection = chooseOrganicDirection(range.anchor, lastDirection, range, centerRandom());
    return lastDirection;
  });
  assert.deepEqual(new Set(directions), new Set(["weth-to-usdc", "usdc-to-weth"]));
  const repeats = directions.slice(1).filter((direction, index) => direction === directions[index]).length;
  const reversals = directions.length - 1 - repeats;
  assert(repeats > reversals, "run persistence should make repeated directions more common than reversals at the anchor");
  assert(reversals > 0, "organic direction choices must not lock into one direction");

  const upperRandom = createSeededRandom(901);
  const lowerRandom = createSeededRandom(901);
  let upperInward = 0;
  let lowerInward = 0;
  for (let index = 0; index < 1_000; index += 1) {
    if (chooseOrganicDirection(105, "usdc-to-weth", range, upperRandom()) === "weth-to-usdc") upperInward += 1;
    if (chooseOrganicDirection(95, "weth-to-usdc", range, lowerRandom()) === "usdc-to-weth") lowerInward += 1;
  }
  assert(upperInward > 600, `upper-side mean reversion was too weak: ${upperInward}/1000`);
  assert(lowerInward > 600, `lower-side mean reversion was too weak: ${lowerInward}/1000`);
});

test("organic direction choices force inward trades at turnaround boundaries", () => {
  for (const roll of [0, 0.25, 0.75, 1]) {
    assert.equal(chooseOrganicDirection(106, "usdc-to-weth", range, roll), "weth-to-usdc");
    assert.equal(chooseOrganicDirection(107, "usdc-to-weth", range, roll), "weth-to-usdc");
    assert.equal(chooseOrganicDirection(94, "weth-to-usdc", range, roll), "usdc-to-weth");
    assert.equal(chooseOrganicDirection(93, "weth-to-usdc", range, roll), "usdc-to-weth");
  }
  assert.throws(() => chooseOrganicDirection(100, "weth-to-usdc", range, -0.01), /between zero and one/);
  assert.throws(() => chooseOrganicDirection(100, "weth-to-usdc", range, 1.01), /between zero and one/);
});

test("trade amount samples are varied and bounded by target, cap, and budget", () => {
  assert.equal(sampleTradeAmount(10_000n, 9_000n, 8_000n, 0, 0), 4_400n);
  assert.equal(sampleTradeAmount(10_000n, 9_000n, 8_000n, 1, 1), 8_000n);
  assert.equal(sampleTradeAmount(100n, 80n, 90n, 1, 1), 80n);
  assert.equal(sampleTradeAmount(100n, 120n, 70n, 1, 1), 70n);
  assert.equal(sampleTradeAmount(1n, 1n, 1n, 0, 0), 1n);

  const random = createSeededRandom(82);
  const samples = Array.from({ length: 100 }, () => sampleTradeAmount(10_000n, 9_000n, 8_000n, random(), random()));
  assert(samples.every((amount) => amount >= 4_400n && amount <= 8_000n));
  assert(new Set(samples).size > 50);
  assert.throws(() => sampleTradeAmount(100n, 100n, 0n, 0.5, 0.5), /must be positive/);
});

test("jittered intervals use bounded triangular variance", () => {
  assert.equal(jitterIntervalMs(1_000, 0, 0), 500);
  assert.equal(jitterIntervalMs(1_000, 0, 1), 1_000);
  assert.equal(jitterIntervalMs(1_000, 1, 1), 1_500);

  const random = createSeededRandom(5_930);
  const intervals = Array.from({ length: 100 }, () => jitterIntervalMs(1_000, random(), random()));
  assert(intervals.every((interval) => interval >= 500 && interval <= 1_500));
  assert(new Set(intervals).size > 50);
  assert.throws(() => jitterIntervalMs(0, 0.5, 0.5), /positive integer/);
});

test("rejects mainnet and builds deterministic 15-day seed coverage", () => {
  assert.throws(() => assertNonMainnetEnvironment("mainnet"), /rejects mainnet/);
  assert.throws(() => assertNonMainnetEnvironment("robinhood"), /rejects mainnet/);
  const now = 2_000_000_000;
  const schedule = buildHistoricalSchedule(now, 73);
  assert.deepEqual(schedule, buildHistoricalSchedule(now, 73));
  assert.notDeepEqual(schedule, buildHistoricalSchedule(now, 74));
  assert(schedule.length > 400);
  assert.equal(schedule[0], now - 15 * 86_400);
  assert.equal(schedule.at(-1), now);
  assert.equal(new Set(schedule).size, schedule.length);
  assert(schedule.every((timestamp, index) => index === 0 || timestamp > schedule[index - 1]!));

  const denseStart = Math.floor((now - 6 * 3_600) / 60) * 60;
  const currentMinute = Math.floor(now / 60) * 60;
  const denseMinutes = new Set(schedule.filter((timestamp) => timestamp >= denseStart).map((timestamp) => Math.floor(timestamp / 60) * 60));
  for (let minute = denseStart; minute <= currentMinute; minute += 60) assert(denseMinutes.has(minute));
  const gaps = schedule.slice(1).map((timestamp, index) => timestamp - schedule[index]!);
  assert(new Set(gaps).size > 50, "historical activity should not follow one mechanical cadence");
});
