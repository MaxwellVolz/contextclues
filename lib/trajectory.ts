// Context trajectory: turning the per-turn usage series into a burn rate and a runway.
//
// Every assistant turn records exact API token counts, so the series itself is observed.
// The burn rate is a median over observed deltas (still observed). The runway extrapolates
// into the future and is therefore inferred — the UI must say "projected", never "will".

import type { TurnPoint, Trajectory } from "./types.ts";

/** Points kept in the API payload. The full payload is re-sent on every SSE update. */
export const MAX_SERIES_POINTS = 400;
/** Most recent turns always kept at full resolution — the burn rate depends on them. */
export const RECENT_FULL_RESOLUTION = 60;
/**
 * Deltas considered when computing the burn rate.
 *
 * Wide enough that the occasional large request (a big file read) is sampled at roughly
 * its true frequency — with a short window, whether one happens to fall inside it swings
 * the projection wildly.
 */
export const BURN_WINDOW = 30;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Quantile by linear interpolation; `s` must already be sorted ascending. */
export function quantileSorted(s: number[], q: number): number {
  if (s.length === 1) return s[0];
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Drop values beyond 1.5x the IQR. One 40k file read otherwise dominates a window of
 * ~8k turns and makes the projection useless. Needs 4+ values for a meaningful IQR.
 */
export function withoutOutliers(values: number[]): number[] {
  if (values.length < 4) return [...values];
  const s = [...values].sort((a, b) => a - b);
  const q1 = quantileSorted(s, 0.25);
  const q3 = quantileSorted(s, 0.75);
  const iqr = q3 - q1;
  if (iqr === 0) return [...values];
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const kept = values.filter((v) => v >= lo && v <= hi);
  return kept.length > 0 ? kept : [...values];
}

/**
 * Reduce a long series for transport while keeping recent detail intact:
 * stride-sample the older span, keep the last RECENT_FULL_RESOLUTION untouched,
 * and always preserve the first and last points exactly.
 */
export function downsample(points: TurnPoint[], cap = MAX_SERIES_POINTS): TurnPoint[] {
  if (points.length <= cap) return points;
  const tailCount = Math.min(RECENT_FULL_RESOLUTION, cap - 1);
  const tail = points.slice(points.length - tailCount);
  const head = points.slice(0, points.length - tailCount);
  const headBudget = cap - tail.length;
  const stride = head.length / headBudget;
  const sampled: TurnPoint[] = [];
  for (let i = 0; i < headBudget; i++) {
    sampled.push(head[Math.min(head.length - 1, Math.floor(i * stride))]);
  }
  // Guarantee the very first point survives sampling.
  if (sampled.length > 0 && sampled[0].lineNo !== head[0].lineNo) sampled[0] = head[0];
  return [...sampled, ...tail];
}

/**
 * Positive turn-over-turn growth. Non-positive deltas mean a compaction or a cache
 * reset rather than negative growth, so they are excluded from the rate.
 */
export function positiveDeltas(points: TurnPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const d = points[i].contextTokens - points[i - 1].contextTokens;
    if (d > 0) out.push(d);
  }
  return out;
}

/** Coefficient of variation — how much to trust a single projected number. */
function coefficientOfVariation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return null;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

export function computeTrajectory(
  points: TurnPoint[],
  maxTokens: number | null,
  currentTokens: number | null,
): Trajectory {
  const empty: Trajectory = {
    turns: downsample(points),
    totalTurns: points.length,
    burnRatePerTurn: null,
    burnRateTypical: null,
    burnRatePerMinute: null,
    turnsRemaining: null,
    turnsRemainingOptimistic: null,
    minutesRemaining: null,
    sampleSize: 0,
    volatility: null,
    reason: null,
    confidence: "observed",
  };

  if (points.length < 2) {
    return { ...empty, reason: "not enough requests to project yet" };
  }

  const allDeltas = positiveDeltas(points);
  const recent = allDeltas.slice(-BURN_WINDOW);

  if (recent.length === 0) {
    return { ...empty, reason: "context is not growing" };
  }

  // Growth per request is strongly right-skewed: most requests add a little, an occasional
  // file read adds a lot.
  //
  // Runway is a question about CUMULATIVE growth, and E[sum] = n * E[delta], so the MEAN
  // is the correct estimator — it counts the large requests at the frequency they actually
  // occur. The median would describe a typical request while systematically under-
  // predicting how fast the window really fills.
  const burnRatePerTurn = recent.reduce((a, b) => a + b, 0) / recent.length;
  // The trimmed median still earns its place as "what a typical request costs", and the
  // gap between the two is exactly how spike-dominated this session is.
  const typical = median(withoutOutliers(recent));

  if (burnRatePerTurn <= 0) {
    return { ...empty, reason: "context is not growing" };
  }

  // Wall-clock rate over the same span of turns the burn rate was taken from.
  const spanTurns = Math.min(recent.length + 1, points.length);
  const span = points.slice(points.length - spanTurns);
  let burnRatePerMinute: number | null = null;
  const firstTs = span[0]?.ts ? Date.parse(span[0].ts) : NaN;
  const lastTs = span[span.length - 1]?.ts ? Date.parse(span[span.length - 1].ts!) : NaN;
  if (Number.isFinite(firstTs) && Number.isFinite(lastTs) && lastTs > firstTs) {
    const grew = span[span.length - 1].contextTokens - span[0].contextTokens;
    const minutes = (lastTs - firstTs) / 60_000;
    if (grew > 0 && minutes > 0) burnRatePerMinute = grew / minutes;
  }

  let turnsRemaining: number | null = null;
  let turnsRemainingOptimistic: number | null = null;
  let minutesRemaining: number | null = null;
  if (maxTokens != null && currentTokens != null) {
    const headroom = Math.max(0, maxTokens - currentTokens);
    turnsRemaining = Math.floor(headroom / burnRatePerTurn);
    // The optimistic end: if the large requests stop and only typical ones continue.
    if (typical != null && typical > 0) {
      const optimistic = Math.floor(headroom / typical);
      turnsRemainingOptimistic = optimistic > turnsRemaining * 1.25 ? optimistic : null;
    }
    if (burnRatePerMinute != null && burnRatePerMinute > 0) {
      minutesRemaining = Math.floor(headroom / burnRatePerMinute);
    }
  }

  // Spike-dominated when the average is far above the typical request.
  const spikeRatio = typical != null && typical > 0 ? burnRatePerTurn / typical : null;
  const cv = coefficientOfVariation(recent);
  const variable = (spikeRatio != null && spikeRatio > 2) || (cv != null && cv > 0.5);

  return {
    turns: downsample(points),
    totalTurns: points.length,
    burnRatePerTurn: Math.round(burnRatePerTurn),
    burnRateTypical: typical == null ? null : Math.round(typical),
    burnRatePerMinute: burnRatePerMinute == null ? null : Math.round(burnRatePerMinute),
    turnsRemaining,
    turnsRemainingOptimistic,
    minutesRemaining,
    sampleSize: recent.length,
    volatility: variable ? "variable" : "steady",
    reason: maxTokens == null ? "context window unknown for this model" : null,
    confidence: "observed",
  };
}
