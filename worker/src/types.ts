export interface Env {
  DB: D1Database;
  INGEST_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  RESEND_API_KEY: string;
  ALERT_EMAIL: string;
  MAIL_FROM: string;
  NTFY_TOPIC?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_SECRET?: string;
}

export interface Route {
  id: number;
  label: string;
  origin: string;
  destination: string;
  depart_date: string;
  return_date: string | null;
  trip_type: 'round-trip' | 'one-way';
  seat: string;
  adults: number;
  max_stops: number | null;
  currency: string;
  target_price: number | null;
  drop_pct: number;
  active: number;
}

export interface PricePoint {
  observed_at: string;
  price: number;
  airlines: string | null;
  stops: number | null;
  duration_min: number | null;
}

export interface Offer {
  price: number;
  airlines: string[];
  stops: number;
  duration_min: number;
}

/** Deterministic, computed in code — never by the model. */
export interface Stats {
  current: number;
  previous: number | null;
  samples: number;
  min: number;
  max: number;
  median: number;
  p20: number;
  mean: number;
  stddev: number;
  /** Where `current` sits in its own history, 0 = cheapest ever seen. */
  percentile: number;
  /** Currency units per day; negative = falling. */
  slopePerDay: number;
  trend: 'falling' | 'flat' | 'rising';
  changeVsPrev: number;
  changePctVsPrev: number;
  daysToDeparture: number;
  spanDays: number;
  isAllTimeLow: boolean;
}

export type Verdict = 'book' | 'wait' | 'watch';

export interface Analysis {
  verdict: Verdict;
  confidence: number;
  headline: string;
  reasoning: string;
  risk: string;
}
