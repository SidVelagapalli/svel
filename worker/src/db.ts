import type { Env, Route, PricePoint, Offer } from './types';

export async function activeRoutes(env: Env): Promise<Route[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM routes WHERE active = 1 ORDER BY id`
  ).all<Route>();
  return results ?? [];
}

export async function getRoute(env: Env, id: number): Promise<Route | null> {
  return env.DB.prepare(`SELECT * FROM routes WHERE id = ?`).bind(id).first<Route>();
}

/** Ascending by time, newest last — the order computeStats expects. */
export async function history(env: Env, routeId: number, limit = 500): Promise<PricePoint[]> {
  // id DESC breaks timestamp ties deterministically — computeStats requires
  // the newest observation to be last, and equal timestamps otherwise order
  // arbitrarily.
  const { results } = await env.DB.prepare(
    `SELECT observed_at, price, airlines, stops, duration_min
       FROM price_points WHERE route_id = ?
       ORDER BY observed_at DESC, id DESC LIMIT ?`
  )
    .bind(routeId, limit)
    .all<PricePoint>();
  return (results ?? []).reverse();
}

export async function recordPrice(
  env: Env,
  routeId: number,
  best: Offer,
  offers: Offer[]
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO price_points (route_id, price, airlines, stops, duration_min, offers)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      routeId,
      best.price,
      best.airlines.join(', '),
      best.stops,
      best.duration_min,
      JSON.stringify(offers.slice(0, 5))
    )
    .run();
}

export async function recordAlert(
  env: Env,
  routeId: number,
  kind: string,
  price: number,
  prevPrice: number | null,
  verdict: string,
  confidence: number,
  headline: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO alerts (route_id, kind, price, prev_price, verdict, confidence, headline)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(routeId, kind, price, prevPrice, verdict, confidence, headline)
    .run();
}

/** Suppresses repeat alerts for the same route within `hours`. */
export async function alertedRecently(env: Env, routeId: number, hours: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS hit FROM alerts
      WHERE route_id = ? AND sent_at > datetime('now', ?)
      LIMIT 1`
  )
    .bind(routeId, `-${hours} hours`)
    .first<{ hit: number }>();
  return row !== null;
}

export async function recordHealth(
  env: Env,
  source: string,
  ok: boolean,
  detail: string
): Promise<void> {
  await env.DB.prepare(`INSERT INTO health (source, ok, detail) VALUES (?, ?, ?)`)
    .bind(source, ok ? 1 : 0, detail)
    .run();
}

export async function addRoute(env: Env, r: Partial<Route>): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO routes
       (label, origin, destination, depart_date, return_date, trip_type,
        seat, adults, max_stops, currency, target_price, drop_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET active = 1, target_price = excluded.target_price
     RETURNING id`
  )
    .bind(
      r.label ?? `${r.origin}→${r.destination}`,
      r.origin,
      r.destination,
      r.depart_date,
      r.return_date ?? null,
      r.trip_type ?? 'round-trip',
      r.seat ?? 'economy',
      r.adults ?? 1,
      r.max_stops ?? null,
      r.currency ?? 'USD',
      r.target_price ?? null,
      r.drop_pct ?? 7.0
    )
    .first<{ id: number }>();
  return res!.id;
}

export async function deactivateRoute(env: Env, id: number): Promise<void> {
  await env.DB.prepare(`UPDATE routes SET active = 0 WHERE id = ?`).bind(id).run();
}
