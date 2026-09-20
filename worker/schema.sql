-- svel.ai — D1 schema

CREATE TABLE IF NOT EXISTS routes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT    NOT NULL,
  origin        TEXT    NOT NULL,
  destination   TEXT    NOT NULL,
  depart_date   TEXT    NOT NULL,
  return_date   TEXT,
  trip_type     TEXT    NOT NULL DEFAULT 'round-trip',
  seat          TEXT    NOT NULL DEFAULT 'economy',
  adults        INTEGER NOT NULL DEFAULT 1,
  max_stops     INTEGER,
  currency      TEXT    NOT NULL DEFAULT 'USD',
  target_price  INTEGER,
  drop_pct      REAL    NOT NULL DEFAULT 7.0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS routes_unique
  ON routes (origin, destination, depart_date, IFNULL(return_date,''), seat, adults);

-- One row per observation. This is the asset: the price history everything else reasons over.
CREATE TABLE IF NOT EXISTS price_points (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id     INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  -- Millisecond resolution: second-granularity timestamps tie whenever two
  -- observations land in the same second, making ordering non-deterministic.
  observed_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  price        INTEGER NOT NULL,
  airlines     TEXT,
  stops        INTEGER,
  duration_min INTEGER,
  offers       TEXT
);

CREATE INDEX IF NOT EXISTS pp_route_time ON price_points (route_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id   INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  sent_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  kind       TEXT    NOT NULL,
  price      INTEGER NOT NULL,
  prev_price INTEGER,
  verdict    TEXT,
  confidence REAL,
  headline   TEXT
);

CREATE INDEX IF NOT EXISTS alerts_route_time ON alerts (route_id, sent_at DESC);

-- Detects scraper breakage so alerts never stop silently.
CREATE TABLE IF NOT EXISTS health (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at TEXT    NOT NULL DEFAULT (datetime('now')),
  source     TEXT    NOT NULL,
  ok         INTEGER NOT NULL,
  detail     TEXT
);

CREATE INDEX IF NOT EXISTS health_time ON health (checked_at DESC);
