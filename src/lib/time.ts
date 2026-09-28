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
