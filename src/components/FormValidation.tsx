import { useState } from 'react';
import { Notice } from './Notice';

/**
 * Validation that waits for the first Save. While a form is being filled in,
 * nothing complains about fields the user has not reached yet; the first
 * Save with a problem shows it next to the button and keeps it up to date
 * from then on. Save stays clickable so that first attempt can happen.
 */
export function useSubmitValidation(errors: readonly string[]): {
  /** The first problem, once a Save was attempted; otherwise null. */
  error: string | null;
  /** Run `save` when the form is valid; otherwise reveal the problem. */
  attempt: (save: () => void) => void;
} {
  const [attempted, setAttempted] = useState(false);
  return {
    error: attempted ? (errors[0] ?? null) : null,
    attempt: (save) => {
      setAttempted(true);
      if (errors.length === 0) save();
    },
  };
}

/** The revealed problem, shown in the form next to its Save button. */
export function FormError({ error }: { error: string | null }): React.JSX.Element | null {
  if (error === null) return null;
  return (
    <Notice inline variant="error" role="alert" style={{ marginBottom: 12 }}>
      {error}
    </Notice>
  );
}
