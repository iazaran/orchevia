import { useEffect, useRef } from 'react';
import { issueNodeLabel, type ValidationIssue, type Workflow } from '../lib/workflow';
import { useAppStore } from '../store';

/**
 * What a workflow still needs, kept out of the way while it is being built.
 * A quiet count in the canvas toolbar opens the list, and each entry selects
 * its step so the inspector shows that step's fields. Nothing pops up while
 * the user is still composing; the Start dialog names the same problems when
 * a run is asked for.
 */
export function SetupStatus({
  workflow,
  issues,
}: {
  workflow: Workflow;
  issues: ValidationIssue[];
}): React.JSX.Element | null {
  const selectNode = useAppStore((s) => s.selectNode);
  const details = useRef<HTMLDetailsElement>(null);
  // An open list closes when the user clicks anywhere else.
  useEffect(() => {
    const close = (event: PointerEvent): void => {
      const element = details.current;
      if (
        element?.open &&
        event.target instanceof Node &&
        !element.contains(event.target)
      )
        element.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  if (issues.length === 0) return null;
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const summary =
    errors > 0
      ? `${String(errors)} to finish`
      : `${String(issues.length)} note${issues.length === 1 ? '' : 's'}`;
  return (
    <details
      ref={details}
      className={`setup-status${errors > 0 ? ' has-errors' : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && details.current?.open) {
          details.current.open = false;
          details.current.querySelector('summary')?.focus();
        }
      }}
    >
      <summary
        title={
          errors > 0
            ? 'What this workflow still needs before it can run'
            : 'Notes about this workflow; it can run'
        }
      >
        {summary}
      </summary>
      <ul role="list" aria-label="Workflow setup">
        {issues.map((issue, index) => {
          const label = issueNodeLabel(workflow, issue);
          const text = (
            <>
              <span className={`setup-issue-kind ${issue.severity}`}>
                {issue.severity === 'error' ? 'Needed' : 'Note'}
              </span>
              {label !== null && <strong>{label}</strong>}
              <span>{issue.message}</span>
            </>
          );
          return (
            <li key={`${issue.code}-${issue.nodeId ?? ''}-${String(index)}`}>
              {label !== null && issue.nodeId !== undefined ? (
                <button
                  type="button"
                  className="setup-issue"
                  title="Select this step"
                  onClick={() => {
                    selectNode(issue.nodeId ?? null);
                    if (details.current) details.current.open = false;
                  }}
                >
                  {text}
                </button>
              ) : (
                <div className="setup-issue">{text}</div>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
