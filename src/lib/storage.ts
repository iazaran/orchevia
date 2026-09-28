/**
 * Guarded localStorage access. Storage can be blocked (private mode, embeds);
 * every read/write here is non-fatal by design — do not wrap these in
 * try/catch at call sites.
 */

export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: non-fatal.
  }
}
