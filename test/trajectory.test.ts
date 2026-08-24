import { test } from "node:test";
import assert from "node:assert/strict";
import { contextWindowForModel } from "../lib/estimate.ts";
import {
  computeTrajectory,
  downsample,
  median,
  positiveDeltas,
  withoutOutliers,
  MAX_SERIES_POINTS,
  RECENT_FULL_RESOLUTION,
} from "../lib/trajectory.ts";
import type { TurnPoint } from "../lib/types.ts";

/** Build a series from cumulative context sizes, one minute apart. */
function series(totals: number[], startMs = Date.parse("2026-08-24T12:00:00.000Z")): TurnPoint[] {
  return totals.map((contextTokens, i) => ({
    n: i + 1,
    lineNo: i + 1,
    ts: new Date(startMs + i * 60_000).toISOString(),
    contextTokens,
    afterCompaction: false,
  }));
}

// ---------- context window table ----------

test("contextWindowForModel: current models are 1M", () => {
  for (const id of ["claude-opus-5", "claude-fable-5", "claude-sonnet-5", "claude-opus-4-8", "claude-sonnet-4-6"]) {
    assert.equal(contextWindowForModel(id).maxTokens, 1_000_000, id);
  }
});

test("contextWindowForModel: Haiku 4.5 is 200K", () => {
  assert.equal(contextWindowForModel("claude-haiku-4-5").maxTokens, 200_000);
  assert.equal(contextWindowForModel("claude-haiku-4-5-20251001").maxTokens, 200_000);
});

test("contextWindowForModel: unknown ids yield null, not a wrong denominator", () => {
  assert.equal(contextWindowForModel("<synthetic>").maxTokens, null);
  assert.equal(contextWindowForModel(null).maxTokens, null);
  assert.equal(contextWindowForModel("some-other-llm").maxTokens, null);
});

test("contextWindowForModel: legacy [1m] marker still resolves", () => {
  assert.equal(contextWindowForModel("claude-sonnet-4-5[1m]").maxTokens, 1_000_000);
});

// ---------- statistics ----------

test("median handles odd and even lengths", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test("withoutOutliers drops a lone huge value", () => {
  const kept = withoutOutliers([8000, 8200, 7900, 8100, 40000]);
  assert.ok(!kept.includes(40000), "40k outlier should be dropped");
  assert.equal(kept.length, 4);
});

test("withoutOutliers keeps everything when values are tight", () => {
  const vals = [8000, 8100, 8050, 7950];
  assert.equal(withoutOutliers(vals).length, 4);
});

test("positiveDeltas excludes compaction drops", () => {
  // grows, then compaction drops it, then grows again
  const pts = series([10_000, 18_000, 4_000, 12_000]);
  assert.deepEqual(positiveDeltas(pts), [8000, 8000]);
});

// ---------- burn rate & runway ----------

test("burn rate: a 40k spike does not move the *typical* rate", () => {
  const totals = [0, 8000, 16_000, 24_000, 64_000, 72_000, 80_000, 88_000];
  const t = computeTrajectory(series(totals), 1_000_000, 88_000);
  assert.ok(
    t.burnRateTypical! >= 7500 && t.burnRateTypical! <= 8500,
    `typical should be ~8000, got ${t.burnRateTypical}`,
  );
  // ...but the average must account for it, or the runway would be over-optimistic.
  assert.ok(
    t.burnRatePerTurn! > t.burnRateTypical!,
    "average must exceed typical when a spike is present",
  );
});

test("burn rate: the average predicts cumulative growth without bias", () => {
  // Six requests: five at 1000, one at 25_000. Mean = 5000.
  const totals = [0];
  for (const d of [1000, 1000, 1000, 25_000, 1000, 1000]) totals.push(totals.at(-1)! + d);
  const t = computeTrajectory(series(totals), 1_000_000, totals.at(-1)!);
  assert.equal(t.burnRatePerTurn, 5000, "mean of the observed deltas");
  assert.equal(t.burnRateTypical, 1000, "typical request is still 1000");
  // Runway must follow the mean, not the median: 995_000 / 5000 ≈ 199
  assert.equal(t.turnsRemaining, Math.floor((1_000_000 - 30_000) / 5000));
});

test("burn rate: a compaction drop is excluded rather than dragging the rate down", () => {
  const totals = [0, 8000, 16_000, 24_000, 5000, 13_000, 21_000, 29_000];
  const t = computeTrajectory(series(totals), 1_000_000, 29_000);
  assert.equal(t.burnRatePerTurn, 8000, "every positive delta is 8000; the drop is ignored");
});

test("runway: arithmetic against a known window", () => {
  const totals = [0, 10_000, 20_000, 30_000, 40_000];
  const t = computeTrajectory(series(totals), 1_000_000, 40_000);
  assert.equal(t.burnRatePerTurn, 10_000);
  assert.equal(t.turnsRemaining, 96); // (1_000_000 - 40_000) / 10_000
  // one minute per turn in the fixture
  assert.equal(t.minutesRemaining, 96);
});

test("runway is null (never Infinity) when context is flat", () => {
  const t = computeTrajectory(series([50_000, 50_000, 50_000, 50_000]), 1_000_000, 50_000);
  assert.equal(t.burnRatePerTurn, null);
  assert.equal(t.turnsRemaining, null);
  assert.equal(t.minutesRemaining, null);
  assert.match(t.reason ?? "", /not growing/);
});

test("runway is null when the model window is unknown", () => {
  const t = computeTrajectory(series([0, 8000, 16_000, 24_000]), null, 24_000);
  assert.ok(t.burnRatePerTurn! > 0, "rate is still computable");
  assert.equal(t.turnsRemaining, null);
  assert.match(t.reason ?? "", /window unknown/i);
});

test("volatility flags an unsteady series", () => {
  const steady = computeTrajectory(series([0, 8000, 16_000, 24_000, 32_000]), 1_000_000, 32_000);
  assert.equal(steady.volatility, "steady");
  const jumpy = computeTrajectory(series([0, 500, 30_000, 31_000, 90_000]), 1_000_000, 90_000);
  assert.equal(jumpy.volatility, "variable");
});

// ---------- degenerate input ----------

test("degenerate series return nulls without throwing", () => {
  for (const totals of [[], [42_000]]) {
    const t = computeTrajectory(series(totals), 1_000_000, totals.at(-1) ?? null);
    assert.equal(t.burnRatePerTurn, null);
    assert.equal(t.turnsRemaining, null);
    assert.equal(t.totalTurns, totals.length);
    assert.match(t.reason ?? "", /not enough requests/);
  }
});

// ---------- skewed growth: the pessimistic bound ----------

test("a spike-dominated series is flagged variable and offers an optimistic bound", () => {
  // mostly small requests, punctuated by large file reads — the real shape
  const totals = [0];
  for (const d of [400, 500, 600, 40_000, 450, 500, 550, 60_000, 500, 600, 450, 500]) {
    totals.push(totals.at(-1)! + d);
  }
  const t = computeTrajectory(series(totals), 1_000_000, totals.at(-1)!);

  assert.ok(t.burnRatePerTurn! > t.burnRateTypical! * 2, "average is spike-dominated");
  assert.equal(t.volatility, "variable");
  assert.ok(t.turnsRemainingOptimistic !== null, "an optimistic bound should be offered");
  assert.ok(
    t.turnsRemainingOptimistic! > t.turnsRemaining!,
    "the optimistic bound must be the longer runway",
  );
});

test("a steady series reports no optimistic bound and reads as steady", () => {
  const totals = [0, 8000, 16_000, 24_000, 32_000, 40_000];
  const t = computeTrajectory(series(totals), 1_000_000, 40_000);
  assert.equal(t.turnsRemainingOptimistic, null, "bounds agree, so no range");
  assert.equal(t.volatility, "steady");
  assert.equal(t.burnRatePerTurn, t.burnRateTypical, "mean and typical agree when uniform");
});

// ---------- downsampling ----------

test("downsample caps length, preserves endpoints, keeps recent turns intact", () => {
  const totals = Array.from({ length: 905 }, (_, i) => i * 1000);
  const full = series(totals);
  const out = downsample(full);

  assert.ok(out.length <= MAX_SERIES_POINTS, `got ${out.length}`);
  assert.equal(out[0].lineNo, full[0].lineNo, "first point preserved");
  assert.equal(out.at(-1)!.lineNo, full.at(-1)!.lineNo, "last point preserved");

  // the final RECENT_FULL_RESOLUTION turns must be consecutive and unsampled
  const tail = out.slice(-RECENT_FULL_RESOLUTION);
  for (let i = 1; i < tail.length; i++) {
    assert.equal(tail[i].lineNo - tail[i - 1].lineNo, 1, "recent tail must be unsampled");
  }
});

test("downsample is a no-op below the cap", () => {
  const full = series(Array.from({ length: 120 }, (_, i) => i * 1000));
  assert.equal(downsample(full).length, 120);
});

test("trajectory series is downsampled but totalTurns reports the true count", () => {
  const totals = Array.from({ length: 905 }, (_, i) => i * 1000);
  const t = computeTrajectory(series(totals), 1_000_000, 904_000);
  assert.equal(t.totalTurns, 905);
  assert.ok(t.turns.length <= MAX_SERIES_POINTS);
  assert.equal(t.turns.at(-1)!.contextTokens, 904_000, "last point matches the headline");
});
