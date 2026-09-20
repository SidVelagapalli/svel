import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeStats, shouldAlert, baselineVerdict } from '../src/stats.ts';
import type { PricePoint, Route } from '../src/types.ts';

const NOW = new Date('2026-09-19T12:00:00Z');

const route = (over: Partial<Route> = {}): Route => ({
  id: 1,
  label: 'test',
  origin: 'JFK',
  destination: 'LHR',
  depart_date: '2026-11-18',
  return_date: '2026-11-25',
  trip_type: 'round-trip',
  seat: 'economy',
  adults: 1,
  max_stops: null,
  currency: 'USD',
  target_price: null,
  drop_pct: 7,
  active: 1,
  ...over,
});

/** n daily observations ending today. */
const series = (prices: number[]): PricePoint[] =>
  prices.map((price, i) => ({
    observed_at: new Date(NOW.getTime() - (prices.length - 1 - i) * 86_400_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19),
    price,
    airlines: 'BA',
    stops: 0,
    duration_min: 420,
  }));

test('percentile: cheapest-ever price is 0th percentile', () => {
  const s = computeStats(series([800, 700, 600, 500, 400]), route(), NOW);
  assert.equal(s.current, 400);
  assert.equal(s.percentile, 0);
  assert.equal(s.isAllTimeLow, true);
  assert.equal(s.min, 400);
  assert.equal(s.max, 800);
});

test('percentile: most expensive price is 100th percentile', () => {
  const s = computeStats(series([400, 500, 600, 700, 800]), route(), NOW);
  assert.equal(s.percentile, 100);
  assert.equal(s.isAllTimeLow, false);
});

test('median and p20 on a known series', () => {
  const s = computeStats(series([100, 200, 300, 400, 500]), route(), NOW);
  assert.equal(s.median, 300);
  // p20 over [100,200,300,400,500] -> index 0.8 -> 100 + 0.8*(200-100)
  assert.equal(s.p20, 180);
});

test('trend: a steady decline reads as falling with a negative slope', () => {
  const s = computeStats(series([900, 850, 800, 750, 700]), route(), NOW);
  assert.equal(s.trend, 'falling');
  assert.ok(s.slopePerDay < 0, `slope ${s.slopePerDay} should be negative`);
  assert.ok(Math.abs(s.slopePerDay - -50) < 0.001);
});

test('trend: noise around a flat mean reads as flat', () => {
  const s = computeStats(series([500, 502, 499, 501, 500]), route(), NOW);
  assert.equal(s.trend, 'flat');
});

test('single observation does not divide by zero', () => {
  const s = computeStats(series([500]), route(), NOW);
  assert.equal(s.samples, 1);
  assert.equal(s.previous, null);
  assert.equal(s.slopePerDay, 0);
  assert.equal(s.stddev, 0);
  assert.equal(s.changePctVsPrev, 0);
  assert.equal(s.percentile, 50);
});

test('days to departure is computed from the route date', () => {
  const s = computeStats(series([500]), route({ depart_date: '2026-10-19' }), NOW);
  assert.equal(s.daysToDeparture, 30);
});

test('alert fires when the price crosses the target', () => {
  const r = route({ target_price: 450 });
  const s = computeStats(series([600, 590, 440]), r, NOW);
  const t = shouldAlert(s, r);
  assert.equal(t.fire, true);
  assert.equal(t.kind, 'target');
});

test('alert fires on a drop past the configured percentage', () => {
  const r = route({ drop_pct: 7 });
  // 600 -> 540 is exactly -10%
  const s = computeStats(series([600, 540]), r, NOW);
  const t = shouldAlert(s, r);
  assert.equal(t.fire, true);
  assert.equal(t.kind, 'drop');
});

test('alert does NOT fire on a drop smaller than the threshold', () => {
  const r = route({ drop_pct: 7 });
  // 600 -> 580 is -3.3%
  const s = computeStats(series([600, 580]), r, NOW);
  assert.equal(shouldAlert(s, r).fire, false);
});

test('all-time low does not alert until there is real history', () => {
  const r = route();
  // -1.7%: too small for the drop rule, so this isolates the all-time-low gate.
  const thin = computeStats(series([600, 590]), r, NOW);
  assert.equal(thin.isAllTimeLow, true);
  assert.equal(shouldAlert(thin, r).kind, 'none', 'two samples is not evidence');

  // Gentle final step (-0.6%) so the drop rule stays out of the way and the
  // all-time-low gate is what actually fires.
  const rich = computeStats(series([900, 880, 870, 860, 855, 850, 845, 840]), r, NOW);
  const t = shouldAlert(rich, r);
  assert.equal(t.fire, true);
  assert.equal(t.kind, 'all_time_low');
  assert.equal(rich.samples, 8, 'gate needs >= 8 observations');
});

test('verdict: withholds judgement on thin history', () => {
  const s = computeStats(series([500, 400]), route(), NOW);
  assert.equal(baselineVerdict(s).verdict, 'watch');
});

test('verdict: book when cheap and no longer falling', () => {
  // Dropped a while ago, flat at the bottom since — the canonical book case.
  const s = computeStats(series([900, 880, 900, 890, 870, 600, 601, 600]), route(), NOW);
  assert.ok(s.current <= s.p20, 'current should be bottom-quintile');
  assert.equal(s.trend, 'flat');
  assert.equal(baselineVerdict(s).verdict, 'book');
});

test('trend reflects recent behaviour, not one old step down', () => {
  // Regression: measuring the slope across all history let a single step-down
  // dominate forever, pinning the verdict to "watch" and never saying book.
  const s = computeStats(series([900, 880, 900, 890, 870, 600, 601, 600]), route(), NOW);
  assert.equal(s.trend, 'flat', 'flat for 3 days is flat, however far it fell before');
  assert.ok(Math.abs(s.slopePerDay) < 5, `slope ${s.slopePerDay} should be near zero`);
});

test('a price still actively falling is not a book signal', () => {
  const s = computeStats(series([900, 850, 800, 750, 700, 650, 600]), route(), NOW);
  assert.equal(s.trend, 'falling');
  assert.equal(baselineVerdict(s).verdict, 'watch', 'still falling and departure is far off');
});

test('verdict: wait when priced above its own typical range', () => {
  const s = computeStats(series([400, 410, 420, 430, 440, 900]), route(), NOW);
  assert.equal(baselineVerdict(s).verdict, 'wait');
});

test('verdict: book inside the 3-week window at a below-median price', () => {
  const r = route({ depart_date: '2026-10-01' }); // 12 days out
  const s = computeStats(series([600, 700, 800, 650, 900, 590]), r, NOW);
  assert.ok(s.daysToDeparture <= 21);
  assert.equal(baselineVerdict(s).verdict, 'book');
});
