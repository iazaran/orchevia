import { useId, useMemo, useRef } from 'react';
import {
  checkJsonSyntax,
  describeJsonError,
  formatJson,
  tokenizeJson,
  type JsonSyntaxError,
  type JsonTokenKind,
} from '../lib/json-syntax';

interface Piece {
  kind: JsonTokenKind;
  text: string;
  mark?: boolean;
}

/** Tokens split into display lines; the character at `markOffset` is marked. */
function highlightLines(text: string, markOffset?: number): Piece[][] {
  const lines: Piece[][] = [[]];
  for (const token of tokenizeJson(text)) {
    const parts = token.text.split('\n');
    let start = token.start;
    parts.forEach((part, index) => {
      if (index > 0) {
        lines.push([]);
        start += 1;
      }
      const line = lines[lines.length - 1];
      if (line === undefined || part === '') return;
      if (
        markOffset !== undefined &&
        markOffset >= start &&
        markOffset < start + part.length
      ) {
        const at = markOffset - start;
        if (at > 0) line.push({ kind: token.kind, text: part.slice(0, at) });
        line.push({ kind: token.kind, text: part.charAt(at), mark: true });
        if (at + 1 < part.length)
          line.push({ kind: token.kind, text: part.slice(at + 1) });
      } else {
        line.push({ kind: token.kind, text: part });
      }
      start += part.length;
    });
  }
  return lines;
}

function renderLine(pieces: Piece[]): React.ReactNode {
  return pieces.map((piece, index) =>
    piece.kind === 'space' && piece.mark !== true ? (
      piece.text
    ) : (
      <span
        // Pieces never reorder within a line, so the index is a stable key.
        key={index}
        className={`json-${piece.kind}${piece.mark === true ? ' json-mark' : ''}`}
      >
        {piece.text}
      </span>
    ),
  );
}

/**
 * JSON text area with syntax colors, line numbers and a live syntax check
 * that points at the line and column of the first problem. The textarea
 * stays the real input (labels, selection, undo and screen readers work as
 * usual); the colored copy underneath is presentation only.
 */
export function JsonEditor({
  id,
  value,
  onChange,
  rows = 16,
  readOnly,
  ariaLabel,
  allowEmpty,
  onFormat,
}: {
  id: string;
  value: string;
  onChange?: (next: string) => void;
  rows?: number;
  readOnly?: boolean;
  ariaLabel?: string;
  /** Empty text is fine (an optional paste box): no error is shown. */
  allowEmpty?: boolean;
  /** Called with the formatted text after Format, when set. */
  onFormat?: (formatted: string) => void;
}): React.JSX.Element {
  const statusId = useId();
  const highlightRef = useRef<HTMLSpanElement>(null);
  const gutterRef = useRef<HTMLSpanElement>(null);
  const error: JsonSyntaxError | null = useMemo(
    () => (allowEmpty === true && value.trim() === '' ? null : checkJsonSyntax(value)),
    [value, allowEmpty],
  );
  const lines = useMemo(() => highlightLines(value, error?.offset), [value, error]);
  // Move the colored copy and the line numbers with the textarea. A
  // transform (not scrollTop) keeps them aligned even when the textarea's
  // horizontal scroll bar makes it scroll further than they could.
  const syncScroll = (event: React.UIEvent<HTMLTextAreaElement>): void => {
    const { scrollTop, scrollLeft } = event.currentTarget;
    if (highlightRef.current !== null)
      highlightRef.current.style.transform = `translate(${String(-scrollLeft)}px, ${String(-scrollTop)}px)`;
    if (gutterRef.current !== null)
      gutterRef.current.style.transform = `translateY(${String(-scrollTop)}px)`;
  };
  const format = (): void => {
    if (error !== null || value.trim() === '') return;
    const formatted = formatJson(value);
    if (formatted === null) return;
    onChange?.(formatted);
    onFormat?.(formatted);
  };
  const empty = value.trim() === '';
  return (
    <div
      className={`json-editor${error !== null ? ' has-error' : ''}${readOnly === true ? ' is-readonly' : ''}`}
      style={{ '--json-rows': rows } as React.CSSProperties}
    >
      <div className="json-editor-body">
        <div className="json-gutter" aria-hidden="true">
          <span className="json-layer" ref={gutterRef}>
            {lines.map((_, index) => (
              <span
                key={index}
                className={error?.line === index + 1 ? 'is-error' : undefined}
              >
                {index + 1}
              </span>
            ))}
          </span>
        </div>
        <div className="json-editor-text">
          <pre className="json-highlight" aria-hidden="true">
            <span className="json-layer" ref={highlightRef}>
              {lines.map((line, index) => (
                <span
                  key={index}
                  className={`json-line${error?.line === index + 1 ? ' is-error' : ''}`}
                >
                  {renderLine(line)}
                </span>
              ))}
            </span>
          </pre>
          <textarea
            id={id}
            className="json-input"
            aria-label={ariaLabel}
            aria-invalid={error !== null}
            aria-describedby={statusId}
            value={value}
            readOnly={readOnly}
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => onChange?.(e.target.value)}
            onScroll={syncScroll}
          />
        </div>
      </div>
      <div className="json-editor-status">
        <span
          id={statusId}
          className={error !== null ? 'json-status-error' : 'json-status-ok'}
        >
          {error !== null
            ? describeJsonError(error)
            : empty
              ? 'Paste or type JSON.'
              : `Valid JSON · ${String(lines.length)} ${lines.length === 1 ? 'line' : 'lines'}`}
        </span>
        {readOnly !== true && (
          <button
            type="button"
            className="btn btn-ghost btn-inline"
            disabled={error !== null || empty}
            onClick={format}
            title="Indent the JSON two spaces per level"
          >
            Format
          </button>
        )}
      </div>
    </div>
  );
}

/** Read-only colored JSON for outputs, proposals and configuration. */
export function JsonView({
  value,
  className,
}: {
  /** A JSON string, or any value to pretty-print. */
  value: unknown;
  className?: string;
}): React.JSX.Element {
  const text = useMemo(() => {
    if (typeof value !== 'string') {
      // `undefined` (and functions) stringify to undefined.
      const json = JSON.stringify(value, null, 2) as string | undefined;
      return json ?? '';
    }
    return formatJson(value) ?? value;
  }, [value]);
  const lines = useMemo(() => highlightLines(text), [text]);
  return (
    <pre
      className={`json-view${className === undefined ? '' : ` ${className}`}`}
      tabIndex={0}
    >
      {lines.map((line, index) => (
        <span key={index} className="json-line">
          {renderLine(line)}
        </span>
      ))}
    </pre>
  );
}
