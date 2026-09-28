-- Separate ledger; existing votes and counter are untouched.
CREATE TABLE IF NOT EXISTS counter_simulated_hours (
  hour_utc INTEGER PRIMARY KEY,
  amount INTEGER NOT NULL CHECK (amount BETWEEN 15 AND 40),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
