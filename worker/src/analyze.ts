import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { Env, Route, Stats, Analysis } from './types';
import { baselineVerdict } from './stats';

const MODEL = 'claude-opus-5';

const AnalysisSchema = z.object({
  verdict: z.enum(['book', 'wait', 'watch']),
  confidence: z.number().min(0).max(1),
  headline: z.string(),
  reasoning: z.string(),
  risk: z.string(),
});

const SYSTEM = `You write flight-price verdicts for svel.ai, a personal fare tracker.

You are given statistics that have ALREADY been computed from a real price history.
Never recompute, re-derive, or contradict those numbers, and never invent figures
that are not in the input. You have no knowledge of this route beyond what is given.

A rule-based baseline verdict is supplied. Follow it unless the statistics plainly
contradict it; if you depart from it, say why in one clause. The house style is
"balanced": recommend booking when the price sits in the bottom fifth of its own
tracked range and is no longer falling.

Calibrate confidence to the evidence. Few samples or a short tracking window means
low confidence, whatever the price is doing.

headline: under 60 characters, plain, no exclamation marks, no emoji.
reasoning: two or three sentences, addressed to the traveller as "you".
risk: one sentence on what would make this the wrong call.`;

function brief(route: Route, s: Stats): string {
  const cur = (n: number) => `${route.currency} ${Math.round(n)}`;
  const base = baselineVerdict(s);
  return [
    `Route: ${route.origin} to ${route.destination} (${route.trip_type}, ${route.seat}, ${route.adults} adult(s))`,
    `Departs ${route.depart_date}${route.return_date ? `, returns ${route.return_date}` : ''} — ${s.daysToDeparture} days away`,
    ``,
    `Current price: ${cur(s.current)}`,
    s.previous !== null
      ? `Previous check: ${cur(s.previous)} (${s.changeVsPrev >= 0 ? '+' : ''}${Math.round(s.changeVsPrev)}, ${s.changePctVsPrev.toFixed(1)}%)`
      : `No previous observation.`,
    ``,
    `History: ${s.samples} observations over ${s.spanDays.toFixed(1)} days`,
    `Cheapest ever seen: ${cur(s.min)} | Median: ${cur(s.median)} | Most expensive: ${cur(s.max)}`,
    `Bottom-quintile threshold (p20): ${cur(s.p20)}`,
    `Current price sits at the ${s.percentile.toFixed(0)}th percentile of its own history (0 = cheapest ever)`,
    `All-time low: ${s.isAllTimeLow ? 'yes' : 'no'}`,
    `Volatility (std dev): ${cur(s.stddev)}`,
    `Trend: ${s.trend} (${s.slopePerDay >= 0 ? '+' : ''}${s.slopePerDay.toFixed(1)} ${route.currency}/day)`,
    route.target_price ? `Your target price: ${cur(route.target_price)}` : `No target price set.`,
    ``,
    `Rule-based baseline verdict: ${base.verdict} — ${base.why}`,
  ].join('\n');
}

/** Falls back to the deterministic baseline if the model is unavailable. */
export async function analyze(env: Env, route: Route, stats: Stats): Promise<Analysis> {
  const base = baselineVerdict(stats);
  const fallback: Analysis = {
    verdict: base.verdict,
    confidence: stats.samples < 5 ? 0.3 : 0.6,
    headline: `${route.origin}→${route.destination} ${route.currency} ${Math.round(stats.current)}`,
    reasoning: `${base.why}. Based on ${stats.samples} observations over ${stats.spanDays.toFixed(1)} days.`,
    risk: 'Generated without model analysis — treat as indicative only.',
  };

  if (!env.ANTHROPIC_API_KEY) return fallback;

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: 'user', content: brief(route, stats) }],
      output_config: {
        effort: 'low',
        format: zodOutputFormat(AnalysisSchema),
      },
    });
    if (res.stop_reason === 'refusal' || !res.parsed_output) return fallback;
    return res.parsed_output;
  } catch (err) {
    console.error('analyze failed', err);
    return fallback;
  }
}

const RouteParseSchema = z.object({
  ok: z.boolean(),
  error: z.string(),
  origin: z.string(),
  destination: z.string(),
  depart_date: z.string(),
  return_date: z.string(),
  trip_type: z.enum(['round-trip', 'one-way']),
  seat: z.enum(['economy', 'premium-economy', 'business', 'first']),
  adults: z.number().int().min(1).max(9),
  target_price: z.number().int().min(0),
  label: z.string(),
});

export type ParsedRoute = z.infer<typeof RouteParseSchema>;

/** Turns "track JFK to Lisbon Mar 3-10 under 500" into a route row. */
export async function parseRouteRequest(
  env: Env,
  text: string,
  today: string
): Promise<ParsedRoute | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 1500,
      system: `Convert a traveller's plain-English flight-tracking request into structured fields.

Today is ${today}. Resolve relative dates against it, and assume any bare date that
has already passed this year refers to next year.

Resolve city names to the primary IATA airport code (Lisbon -> LIS, London -> LHR,
New York -> JFK, Tokyo -> HND). Uppercase, three letters.

Set ok=false and explain in error if the origin, destination, or departure date is
missing or genuinely ambiguous. Do not guess a departure date that was not stated.

Defaults when unstated: trip_type round-trip if a return date is given else one-way,
seat economy, adults 1, target_price 0 (meaning none), return_date "" if one-way.
label: a short human name like "NYC → Lisbon (March)".`,
      messages: [{ role: 'user', content: text }],
      output_config: { effort: 'low', format: zodOutputFormat(RouteParseSchema) },
    });
    if (res.stop_reason === 'refusal') return null;
    return res.parsed_output ?? null;
  } catch (err) {
    console.error('parseRouteRequest failed', err);
    return null;
  }
}
