// Automatic additions are separate from actual votes and never modify counter/votes.
export const START = Date.parse('2026-09-28T11:00:00-05:00');
export const END = Date.parse('2026-10-05T00:00:00-05:00');
const HOUR = 3600000;
export function randomAddition() {
  const values = new Uint32Array(1);
  // Rejection sampling avoids modulo bias for the 41 possible values.
  do { crypto.getRandomValues(values); } while (values[0] >= 4294967259);
  return 80 + values[0] % 41;
}
export async function addScheduledSimulation(env, scheduledTime) {
  const hour = Math.floor(scheduledTime / HOUR) * HOUR;
  if (!Number.isFinite(hour) || hour < START || hour >= END) return;
  await env.DB.prepare('INSERT OR IGNORE INTO counter_simulated_hours_v2 (hour_utc, amount) VALUES (?, ?)')
    .bind(hour, randomAddition()).run();
}
export async function counterSummary(env, baseValue) {
  let simulated = 0;
  try {
    const row = await env.DB.prepare('SELECT (SELECT COALESCE(SUM(amount), 0) FROM counter_simulated_hours) + (SELECT COALESCE(SUM(amount), 0) FROM counter_simulated_hours_v2) AS total').first();
    simulated = Number(row?.total || 0);
  } catch (error) {
    // Preserve the existing counter if this Worker is deployed before the migration.
    if (!String(error.message).includes('no such table: counter_simulated_hours')) throw error;
  }
  const votes = await env.DB.prepare('SELECT COUNT(*) AS total FROM votes').first();
  return { value: Number(baseValue || 0) + simulated, base_value: Number(baseValue || 0),
    real_votes: Number(votes?.total || 0), automated_value: simulated, includes_automatic_increments: true };
}
