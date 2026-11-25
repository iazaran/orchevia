import { describe, expect, it } from 'vitest';
import {
  checkJsonSyntax,
  describeJsonError,
  formatJson,
  lineColumn,
  tokenizeJson,
} from './json-syntax';

describe('tokenizeJson', () => {
  it('covers every character and marks object keys', () => {
    const text =
      '{\n  "name": "Demo",\n  "count": -1.5e3,\n  "ok": true,\n  "x": null\n}';
    const tokens = tokenizeJson(text);
    expect(tokens.map((t) => t.text).join('')).toBe(text);
    const kinds = tokens
      .filter((t) => t.kind !== 'space')
      .map((t) => `${t.kind}:${t.text}`);
    expect(kinds).toEqual([
      'punct:{',
      'key:"name"',
      'punct::',
      'string:"Demo"',
      'punct:,',
      'key:"count"',
      'punct::',
      'number:-1.5e3',
      'punct:,',
      'key:"ok"',
      'punct::',
      'boolean:true',
      'punct:,',
      'key:"x"',
      'punct::',
      'null:null',
      'punct:}',
    ]);
  });

  it('keeps escaped quotes inside strings and flags stray words', () => {
    const tokens = tokenizeJson('["a \\" b", nope]');
    expect(tokens.find((t) => t.kind === 'string')?.text).toBe('"a \\" b"');
    expect(tokens.find((t) => t.kind === 'invalid')?.text).toBe('nope');
  });

  it('stops an unterminated string at the end of its line', () => {
    const tokens = tokenizeJson('{"a\n}');
    expect(tokens[1]).toMatchObject({ kind: 'string', text: '"a' });
    expect(tokens.map((t) => t.text).join('')).toBe('{"a\n}');
  });
});

describe('checkJsonSyntax', () => {
  it('accepts valid documents', () => {
    for (const text of [
      '{}',
      '[]',
      '"x"',
      '0',
      '{"a":[1,2,{"b":false}]}',
      ' \n{"u":"\\u00e9"}\n',
    ])
      expect(checkJsonSyntax(text)).toBeNull();
  });

  it('points at a missing comma with its line and column', () => {
    const error = checkJsonSyntax('{\n  "a": 1\n  "b": 2\n}');
    expect(error).toMatchObject({ line: 2, column: 8 });
    expect(error === null ? '' : describeJsonError(error)).toBe(
      'Line 2, column 8: Add a comma after this value, or a } to close the object.',
    );
  });

  it('names trailing commas, single quotes, bare words and unclosed brackets', () => {
    expect(checkJsonSyntax('{"a": 1,\n}')?.message).toBe(
      'Remove the comma before this }',
    );
    expect(checkJsonSyntax('{"a": 1,\n}')).toMatchObject({ line: 1, column: 8 });
    expect(checkJsonSyntax('[1, 2,]')?.message).toBe('Remove the comma before this ]');
    expect(checkJsonSyntax("{'a': 1}")?.message).toBe(
      'Expected a property name in double quotes',
    );
    expect(checkJsonSyntax('{"a": hello}')?.message).toBe(
      "'hello' is not a JSON value; text needs double quotes",
    );
    expect(checkJsonSyntax('{"a": [1, 2}')?.message).toBe(
      'Add a comma after this value, or a ] to close the list',
    );
    expect(checkJsonSyntax('{\n"a": 1')).toMatchObject({
      message: 'This { is never closed',
      line: 1,
      column: 1,
    });
    expect(checkJsonSyntax('{"a": "x\n"}')?.message).toBe(
      'This string is missing its closing quote',
    );
    expect(checkJsonSyntax('{} {}')?.message).toBe(
      "Unexpected '{' after the end of the document",
    );
    expect(checkJsonSyntax('   ')?.message).toBe('Enter a JSON document');
    expect(checkJsonSyntax('{"a": "\\q"}')?.message).toBe(
      "'\\q' is not a valid escape in JSON",
    );
    expect(checkJsonSyntax('[01]')).toMatchObject({ column: 2 });
  });

  it('agrees with JSON.parse on whether text is valid', () => {
    const samples = [
      '{"a":1}',
      '{"a":1,}',
      '[1 2]',
      '{"a":-}',
      '"\\u12"',
      '{"a":1}}',
      '[true, false, null]',
      '{"nested": {"deep": [[], {}]}}',
      '1e5',
      '.5',
    ];
    for (const text of samples) {
      let parses = true;
      try {
        JSON.parse(text);
      } catch {
        parses = false;
      }
      expect(checkJsonSyntax(text) === null, text).toBe(parses);
    }
  });
});

it('lineColumn counts lines from 1', () => {
  expect(lineColumn('ab\ncd', 0)).toEqual({ line: 1, column: 1 });
  expect(lineColumn('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
  expect(lineColumn('ab\ncd', 99)).toEqual({ line: 2, column: 3 });
});

it('checks very deep documents without overflowing the stack', () => {
  const deep = '['.repeat(20000) + '0' + ']'.repeat(20000);
  expect(checkJsonSyntax(deep)).toBeNull();
  expect(checkJsonSyntax('['.repeat(20000) + '0' + ']'.repeat(19999))?.message).toBe(
    'This deeply nested JSON is not valid',
  );
});

describe('formatJson', () => {
  it('indents like JSON.stringify for ordinary documents', () => {
    const text = '{"a":[1,2,{"b":null}],"c":{},"d":[],"e":"x, y: {z}"}';
    expect(formatJson(text)).toBe(JSON.stringify(JSON.parse(text) as unknown, null, 2));
  });

  it('keeps numbers exactly as written and refuses invalid JSON', () => {
    expect(formatJson('{"id":9007199254740993,"x":1e400,"y":1.50}')).toBe(
      '{\n  "id": 9007199254740993,\n  "x": 1e400,\n  "y": 1.50\n}',
    );
    expect(formatJson('{"a":1,}')).toBeNull();
  });
});
