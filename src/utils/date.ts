/** Small date helpers used by analytics and token-refresh logic. */

/** Start of the day (00:00:00.000) for a given date. */
export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** End of the day (23:59:59.999) for a given date. */
export function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Add (or subtract, with a negative value) days to a date. */
export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Date N days ago from now. */
export function daysAgo(days: number): Date {
  return addDays(new Date(), -days);
}

/** Format a date as YYYY-MM-DD in local time (used for display/filenames). */
export function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Start of the UTC day (00:00:00.000Z). */
export function startOfDayUTC(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** End of the UTC day (23:59:59.999Z). */
export function endOfDayUTC(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

/**
 * Format a date as YYYY-MM-DD in UTC. Analytics buckets key on this so writes
 * and range reads agree regardless of the server's timezone (see
 * analytics.repository — the stored `date` is UTC midnight).
 */
export function toDateKeyUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Format a date as YYYY-MM (month key) for monthly aggregations. */
export function toMonthKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
