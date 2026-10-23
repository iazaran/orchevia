import { useState } from 'react';

/**
 * The text a field shows while its value is stored in a cleaned-up form
 * (trimmed, blank lines dropped). Showing the stored value back on every
 * keystroke would swallow a new line or a space typed at the end, so the
 * typed draft is shown while it still means the stored value; a change from
 * elsewhere (Browse, another node, an import) shows the stored value instead.
 */
export function useDraftText(
  stored: string,
  normalize: (text: string) => string,
): [string, (text: string) => void] {
  const [draft, setDraft] = useState(stored);
  return [normalize(draft) === stored ? draft : stored, setDraft];
}

/** One entry per line, trimmed, blank lines dropped. */
export function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** A textarea holding one entry per line that lets the user start a new line. */
export function LinesTextarea({
  value,
  onChange,
  ...props
}: {
  value: readonly string[];
  onChange: (lines: string[]) => void;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>): React.JSX.Element {
  const [shown, setDraft] = useDraftText(value.join('\n'), (text) =>
    parseLines(text).join('\n'),
  );
  return (
    <textarea
      className="textarea"
      {...props}
      value={shown}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(parseLines(e.target.value));
      }}
    />
  );
}

/** `key=value` lines; lines without a key (still being typed) are left out. */
export function parseKeyValueLines(text: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return pairs;
}

function formatKeyValueLines(pairs: Readonly<Record<string, string>>): string {
  return Object.entries(pairs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/** A textarea of `key=value` lines that keeps a half-typed line visible. */
export function KeyValueTextarea({
  value,
  onChange,
  ...props
}: {
  value: Readonly<Record<string, string>>;
  onChange: (pairs: Record<string, string>) => void;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>): React.JSX.Element {
  const [shown, setDraft] = useDraftText(formatKeyValueLines(value), (text) =>
    formatKeyValueLines(parseKeyValueLines(text)),
  );
  return (
    <textarea
      className="textarea"
      {...props}
      value={shown}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(parseKeyValueLines(e.target.value));
      }}
    />
  );
}
