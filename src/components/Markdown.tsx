import { useMemo, useState } from 'react';
import { isMarkdown, renderMarkdown } from '../lib/markdown';

/**
 * Formatted agent text: renders markdown when detected, with a Raw toggle.
 * Falls back to plain preformatted text for logs. Detection and rendering run
 * once per text value, not on unrelated rerenders or Raw/Formatted toggles.
 */
export function MarkdownText({
  text,
  allowRaw,
}: {
  text: string;
  allowRaw?: boolean;
}): React.JSX.Element {
  const [raw, setRaw] = useState(false);
  const markdown = useMemo(() => isMarkdown(text), [text]);
  const html = useMemo(() => (markdown ? renderMarkdown(text) : ''), [markdown, text]);
  if (!markdown) {
    return <div className="log-block">{text}</div>;
  }
  const showRawToggle = allowRaw !== false;
  if (raw) {
    return (
      <div>
        <div className="log-block">{text}</div>
        {showRawToggle && (
          <button
            className="btn btn-ghost output-toggle"
            aria-label="Show formatted text"
            onClick={() => {
              setRaw(false);
            }}
          >
            Formatted ▲
          </button>
        )}
      </div>
    );
  }
  return (
    <div>
      <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
      {showRawToggle && (
        <button
          className="btn btn-ghost output-toggle"
          aria-label="Show raw text"
          onClick={() => {
            setRaw(true);
          }}
        >
          Raw ▼
        </button>
      )}
    </div>
  );
}
