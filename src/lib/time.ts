/**
 * Human-friendly timestamps. Raw ISO/RFC3339 strings (e.g.
 * `2026-09-23T20:34:45.483763133Z`) are precise but unreadable in lists, so
 * UI rows show the locale form and keep the exact value in `title`.
 */

/** Locale form of an ISO/RFC3339 timestamp; returns the input on parse failure. */
export function formatTime(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString();
  } catch {
    return iso;
  }
}

/** Compact date form (no time) for dense rows; falls back like formatTime. */
export function formatDate(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleDateString();
  } catch {
    return iso;
  }
}

/**
 * Short distance from `now`. Past: "just now", "5 min ago", "2 h ago" (whole
 * hours, today), "yesterday 18:30", "3 days ago". Next: "now", "in 20 min",
 * "today 17:30", "tomorrow 09:00", "Mon 09:00". Beyond a week, the date.
 * Rows keep the exact time in `title` (`formatTime`).
 */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  const diff = time - now;
  const minutes = Math.round(Math.abs(diff) / 60_000);
  const clock = new Date(time).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const date = new Date(time);
  const today = new Date(now);
  const dayOffset = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86_400_000,
  );
  if (diff <= 0) {
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${String(minutes)} min ago`;
    if (dayOffset === 0) return `${String(Math.floor(minutes / 60))} h ago`;
    if (dayOffset === -1) return `yesterday ${clock}`;
    if (dayOffset > -7) return `${String(-dayOffset)} days ago`;
    return formatDate(iso);
  }
  if (minutes < 1) return 'now';
  if (minutes < 60) return `in ${String(minutes)} min`;
  if (dayOffset === 0) return `today ${clock}`;
  if (dayOffset === 1) return `tomorrow ${clock}`;
  if (dayOffset < 7)
    return `${date.toLocaleDateString([], { weekday: 'short' })} ${clock}`;
  return formatDate(iso);
}
