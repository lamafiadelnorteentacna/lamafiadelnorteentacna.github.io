-- New hourly ledger preserves every previously recorded 15–40 increment.
CREATE TABLE IF NOT EXISTS counter_simulated_hours_v2 (
  hour_utc INTEGER PRIMARY KEY,
  amount INTEGER NOT NULL CHECK (amount BETWEEN 80 AND 120),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
