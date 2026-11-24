/**
 * JSON tokens for syntax coloring, and a strict parser check that reports
 * where a document breaks. Browsers word `JSON.parse` errors differently and
 * WebKit (the macOS and Linux desktop webview) gives no position at all, so
 * the editor checks syntax here to point at the exact line and column.
 */

export type JsonTokenKind =
  'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct' | 'space' | 'invalid';

export interface JsonToken {
  kind: JsonTokenKind;
  text: string;
  /** Offset of the first character in the source text. */
  start: number;
}

export interface JsonSyntaxError {
  message: string;
  /** Offset of the problem in the source text (0-based). */
  offset: number;
  /** 1-based line and column of `offset`. */
  line: number;
  column: number;
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WORD = /[A-Za-z_$][\w$]*/y;
const SPACE = /[ \t\r\n]+/y;

/**
 * Split `text` into tokens that cover every character, in order. Anything
 * that is not JSON becomes an `invalid` token, so coloring never drops text.
 */
export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      SPACE.lastIndex = i;
      const match = SPACE.exec(text);
      const len = match?.[0].length ?? 1;
      tokens.push({ kind: 'space', text: text.slice(i, i + len), start: i });
      i += len;
      continue;
    }
    if (c === '"') {
      const end = stringEnd(text, i);
      tokens.push({ kind: 'string', text: text.slice(i, end), start: i });
      i = end;
      continue;
    }
    if ('{}[]:,'.includes(c)) {
      tokens.push({ kind: 'punct', text: c, start: i });
      i += 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i;
      const match = NUMBER.exec(text);
      if (match !== null && match[0] !== '' && match[0] !== '-') {
        tokens.push({ kind: 'number', text: match[0], start: i });
        i += match[0].length;
        continue;
      }
    }
    WORD.lastIndex = i;
    const word = WORD.exec(text);
    if (word !== null) {
      const value = word[0];
      const kind: JsonTokenKind =
        value === 'true' || value === 'false'
          ? 'boolean'
          : value === 'null'
            ? 'null'
            : 'invalid';
      tokens.push({ kind, text: value, start: i });
      i += value.length;
      continue;
    }
    tokens.push({ kind: 'invalid', text: c, start: i });
    i += 1;
  }
  // A string followed (after spaces) by a colon is an object key.
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    if (token?.kind !== 'string') continue;
    let next = t + 1;
    while (tokens[next]?.kind === 'space') next++;
    if (tokens[next]?.text === ':') token.kind = 'key';
  }
  return tokens;
}

/** End offset (exclusive) of the string starting at `start`; unterminated strings stop at the line end. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    if (c === '\n') return i;
    i += 1;
  }
  return text.length;
}

/** 1-based line and column of an offset. */
export function lineColumn(
  text: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(Math.max(offset, 0), text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}

class JsonCheckError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

/**
 * Check `text` against strict JSON (RFC 8259). Returns `null` when it parses,
 * otherwise the first problem with a plain-language message and its position.
 * Empty text is an error: there is no document to save.
 */
export function checkJsonSyntax(text: string): JsonSyntaxError | null {
  let i = 0;
  const fail = (message: string, at = i): never => {
    throw new JsonCheckError(message, at);
  };
  const skipSpace = (): void => {
    while (i < text.length && ' \t\r\n'.includes(text.charAt(i))) i++;
  };
  const describe = (at: number): string => {
    if (at >= text.length) return 'the end of the text';
    const c = text.charAt(at);
    return c === '\n' ? 'a line break' : `'${c}'`;
  };
  const parseString = (what: string): void => {
    if (text.charAt(i) !== '"') fail(`Expected ${what} in double quotes`);
    const start = i;
    i += 1;
    while (i < text.length) {
      const c = text.charAt(i);
      if (c === '"') {
        i += 1;
        return;
      }
      if (c === '\n') fail('This string is missing its closing quote', start);
      if (c.charCodeAt(0) < 0x20) fail('Control characters must be escaped in strings');
      if (c === '\\') {
        const next = text.charAt(i + 1);
        if (next === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6)))
            fail('A \\u escape needs four hexadecimal digits');
          i += 6;
          continue;
        }
        if (!'"\\/bfnrt'.includes(next) || next === '')
          fail(`'\\${next}' is not a valid escape in JSON`);
        i += 2;
        continue;
      }
      i += 1;
    }
    fail('This string is missing its closing quote', start);
  };
  const parseValue = (): void => {
    skipSpace();
    const c = text.charAt(i);
    if (c === '{') {
      parseObject();
      return;
    }
    if (c === '[') {
      parseArray();
      return;
    }
    if (c === '"') {
      parseString('a value');
      return;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i;
      const match = NUMBER.exec(text);
      if (match === null || match[0] === '' || match[0] === '-')
        fail('This number is not valid JSON');
      i += match?.[0].length ?? 1;
      return;
    }
    WORD.lastIndex = i;
    const word = WORD.exec(text)?.[0];
    if (word === 'true' || word === 'false' || word === 'null') {
      i += word.length;
      return;
    }
    if (word !== undefined)
      fail(`'${word}' is not a JSON value; text needs double quotes`);
    if (i >= text.length) fail('The text ends before a value');
    if (c === '}' || c === ']') fail(`Expected a value before ${describe(i)}`);
    if (c === "'") fail('JSON strings use double quotes, not single quotes');
    fail(`Unexpected ${describe(i)}`);
  };
  const parseObject = (): void => {
    const open = i;
    i += 1;
    skipSpace();
    if (text.charAt(i) === '}') {
      i += 1;
      return;
    }
    for (;;) {
      skipSpace();
      if (text.charAt(i) === '}') fail('Remove the comma before this }', lastComma);
      if (i >= text.length) fail('This { is never closed', open);
      parseString('a property name');
      skipSpace();
      if (text.charAt(i) !== ':')
        fail(`Expected ':' after the property name, found ${describe(i)}`);
      i += 1;
      parseValue();
      const valueEnd = i;
      skipSpace();
      const c = text.charAt(i);
      if (c === ',') {
        lastComma = i;
        i += 1;
        continue;
      }
      if (c === '}') {
        i += 1;
        return;
      }
      if (i >= text.length) fail('This { is never closed', open);
      fail('Add a comma after this value, or a } to close the object', valueEnd - 1);
    }
  };
  const parseArray = (): void => {
    const open = i;
    i += 1;
    skipSpace();
    if (text.charAt(i) === ']') {
      i += 1;
      return;
    }
    for (;;) {
      skipSpace();
      if (text.charAt(i) === ']') fail('Remove the comma before this ]', lastComma);
      if (i >= text.length) fail('This [ is never closed', open);
      parseValue();
      const valueEnd = i;
      skipSpace();
      const c = text.charAt(i);
      if (c === ',') {
        lastComma = i;
        i += 1;
        continue;
      }
      if (c === ']') {
        i += 1;
        return;
      }
      if (i >= text.length) fail('This [ is never closed', open);
      fail('Add a comma after this value, or a ] to close the list', valueEnd - 1);
    }
  };
  let lastComma = 0;
  try {
    skipSpace();
    if (i >= text.length) fail('Enter a JSON document');
    parseValue();
    skipSpace();
    if (i < text.length) fail(`Unexpected ${describe(i)} after the end of the document`);
    return null;
  } catch (err) {
    if (!(err instanceof JsonCheckError)) throw err;
    const { line, column } = lineColumn(text, err.offset);
    return { message: err.message, offset: err.offset, line, column };
  }
}

/** `"Line 4, column 9: …"` for notices and screen readers. */
export function describeJsonError(error: JsonSyntaxError): string {
  return `Line ${String(error.line)}, column ${String(error.column)}: ${error.message}.`;
}
