import { useState } from 'react';
import { isMarkdown, renderMarkdown } from '../lib/markdown';

/**
 * Formatted agent text: renders markdown when detected, with a Raw toggle.
 * Falls back to plain preformatted text for logs.
 */
export function MarkdownText({
  text,
  allowRaw,
}: {
  text: string;
  allowRaw?: boolean;
}): React.JSX.Element {
  const [raw, setRaw] = useState(false);
  if (!isMarkdown(text)) {
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
      <div
        className="md-body"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
      />
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
