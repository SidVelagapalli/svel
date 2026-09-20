import type { PricePoint, Stats, Route, Verdict } from './types';

const DAY_MS = 86_400_000;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Trailing days the trend is measured over. At 30-min polling this is ~144
  * observations — enough to be stable, short enough to still mean "right now". */
const TREND_WINDOW_DAYS = 3;

/**
 * The trend must describe what the price is doing *now*, not the whole history.
 * Regressing over everything lets a single step-down weeks ago dominate the
 * slope forever, so a route that dropped and then went flat would read
 * "falling" indefinitely and never earn a book verdict.
 */
function trendWindow(points: PricePoint[]): PricePoint[] {
  if (points.length < 3) return points;
  const newest = Date.parse(points[points.length - 1].observed_at + 'Z');
  const cutoff = newest - TREND_WINDOW_DAYS * DAY_MS;
  const recent = points.filter((p) => Date.parse(p.observed_at + "Z") > cutoff);
  // Sparse polling can leave the window nearly empty — fall back to a point count.
  return recent.length >= 3 ? recent : points.slice(-5);
}

/** Ordinary least squares slope of price over days. */
function slopePerDay(points: PricePoint[]): number {
  if (points.length < 2) return 0;
  const t0 = Date.parse(points[0].observed_at + 'Z');
  const xs = points.map((p) => (Date.parse(p.observed_at + 'Z') - t0) / DAY_MS);
  const ys = points.map((p) => p.price);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  // All observations share a timestamp — no time axis to regress on.
  if (den === 0) return 0;
  return num / den;
}

/**
 * `history` must be ascending by observed_at, and must already include the
 * newest observation as its last element.
 */
export function computeStats(history: PricePoint[], route: Route, now = new Date()): Stats {
  const prices = history.map((p) => p.price);
  const current = prices[prices.length - 1];
  const previous = prices.length > 1 ? prices[prices.length - 2] : null;
  const sorted = [...prices].sort((a, b) => a - b);

  const n = prices.length;
  const mean = prices.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? prices.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);

  // Fraction of observations strictly cheaper than the current price.
  const cheaper = prices.filter((p) => p < current).length;
  const percentile = n > 1 ? (cheaper / (n - 1)) * 100 : 50;

  const window = trendWindow(history);
  const slope = slopePerDay(window);
  // Treat drift under ~0.4% of the window's mean per day as noise, not a trend.
  const windowMean = window.reduce((a, b) => a + b.price, 0) / window.length;
  const flatBand = Math.max(1, windowMean * 0.004);
  const trend: Stats['trend'] = slope < -flatBand ? 'falling' : slope > flatBand ? 'rising' : 'flat';

  const changeVsPrev = previous === null ? 0 : current - previous;
  const changePctVsPrev = previous ? (changeVsPrev / previous) * 100 : 0;

  const depart = Date.parse(route.depart_date + 'T00:00:00Z');
  const daysToDeparture = Math.round((depart - now.getTime()) / DAY_MS);

  const firstT = Date.parse(history[0].observed_at + 'Z');
  const lastT = Date.parse(history[n - 1].observed_at + 'Z');
  const spanDays = (lastT - firstT) / DAY_MS;

  return {
    current,
    previous,
    samples: n,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: quantile(sorted, 0.5),
    p20: quantile(sorted, 0.2),
    mean,
    stddev,
    percentile,
    slopePerDay: slope,
    trend,
    changeVsPrev,
    changePctVsPrev,
    daysToDeparture,
    spanDays,
    isAllTimeLow: current <= sorted[0],
  };
}

export interface Trigger {
  fire: boolean;
  kind: 'target' | 'drop' | 'all_time_low' | 'none';
  reason: string;
}

/**
 * Deterministic gate. The model never decides *whether* to wake you up —
 * it only explains a decision this function already made.
 */
export function shouldAlert(stats: Stats, route: Route): Trigger {
  if (route.target_price !== null && stats.current <= route.target_price) {
    return {
      fire: true,
      kind: 'target',
      reason: `${stats.current} is at or below your ${route.target_price} target`,
    };
  }
  if (stats.previous !== null && stats.changePctVsPrev <= -route.drop_pct) {
    return {
      fire: true,
      kind: 'drop',
      reason: `dropped ${Math.abs(stats.changePctVsPrev).toFixed(1)}% since the last check`,
    };
  }
  // Needs real history behind it — the first few readings are trivially "lows".
  if (stats.isAllTimeLow && stats.samples >= 8) {
    return {
      fire: true,
      kind: 'all_time_low',
      reason: `cheapest of ${stats.samples} observations`,
    };
  }
  return { fire: false, kind: 'none', reason: '' };
}

/**
 * "Balanced" verdict: buy when the price is in the bottom fifth of its own
 * tracked range AND the trend is no longer working in your favour.
 */
export function baselineVerdict(stats: Stats): { verdict: Verdict; why: string } {
  if (stats.samples < 5) {
    return { verdict: 'watch', why: 'not enough history yet to judge this price' };
  }
  const cheap = stats.current <= stats.p20;
  const closing = stats.daysToDeparture <= 21;

  if (cheap && stats.trend !== 'falling') {
    return { verdict: 'book', why: 'bottom-quintile price and no longer falling' };
  }
  if (cheap && stats.trend === 'falling' && !closing) {
    return { verdict: 'watch', why: 'cheap but still falling, and departure is far off' };
  }
  if (closing && stats.current <= stats.median) {
    return { verdict: 'book', why: 'inside the 3-week window at a below-median price' };
  }
  if (stats.trend === 'rising' && stats.current <= stats.median) {
    return { verdict: 'book', why: 'below median and climbing' };
  }
  return { verdict: 'wait', why: 'priced above its own typical range' };
}
