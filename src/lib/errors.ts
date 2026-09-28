/**
 * Single error-to-message conversion. Every backend rejection surface uses
 * this instead of repeating the `instanceof` ternary — do not inline it.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
