import { describe, expect, it } from 'vitest';
import { evalCondition, parseCondition, renderCondition } from './conditions';

describe('condition expressions', () => {
  it('parses and evaluates contains', () => {
    const config = parseCondition('review.severity contains "P0"');
    expect(evalCondition(config, { 'review.severity': 'P0 found' })).toBe(true);
    expect(evalCondition(config, { 'review.severity': 'clean' })).toBe(false);
  });

  it('handles equality and or-logic', () => {
    const config = parseCondition('a == 1 or b != 2');
    expect(config.logic).toBe('or');
    expect(evalCondition(config, { a: '1', b: '2' })).toBe(true);
    expect(evalCondition(config, { a: '0', b: '2' })).toBe(false);
  });

  it('rejects mixed and/or and unknown operators', () => {
    expect(() => parseCondition('a == 1 and b == 2 or c == 3')).toThrow(/grouping/);
    expect(() => parseCondition('a ~= b')).toThrow(/operator/);
  });

  it('round-trips through render', () => {
    for (const text of ['node.r.severity contains "P0"', 'command.exitCode == 0']) {
      const config = parseCondition(text);
      expect(parseCondition(renderCondition(config))).toEqual(config);
    }
  });

  it('errors on missing variables and non-numeric comparisons', () => {
    const config = parseCondition('node.ghost.output == x');
    expect(() => evalCondition(config, {})).toThrow(/Unknown variable/);
    const numeric = parseCondition('node.n.exitCode > 0');
    expect(() => evalCondition(numeric, { 'node.n.exitCode': 'oops' })).toThrow(
      /numeric/,
    );
  });
});

describe('snake_case operator aliases', () => {
  it('parses not_contains / not_equals / *_or_equal like the Rust backend', () => {
    expect(parseCondition('node.r.severity not_contains "P0"').clauses[0]?.op).toBe(
      'notContains',
    );
    expect(parseCondition('a not_equals b').clauses[0]?.op).toBe('notEquals');
    expect(parseCondition('a greater_or_equal b').clauses[0]?.op).toBe('greaterOrEqual');
    expect(parseCondition('a less_or_equal b').clauses[0]?.op).toBe('lessOrEqual');
  });
});

describe('rendering round-trips every value', () => {
  it.each(['a b\\c', 'or', 'AND', 'x\\"y z', '"', 'C:\\path', 'plain'])(
    'keeps %s as the value',
    (right) => {
      const config = {
        logic: 'and' as const,
        clauses: [{ left: 'input.x', op: 'equals' as const, right }],
      };
      expect(parseCondition(renderCondition(config))).toEqual(config);
    },
  );

  it('still joins clauses on bare and/or', () => {
    expect(parseCondition('input.a == "or" or input.b == and2').clauses).toHaveLength(2);
  });
});

it('reads not contains like the core does', () => {
  expect(parseCondition('input.a not contains "P0"').clauses[0]?.op).toBe('notContains');
  expect(() => parseCondition('input.a "not" "contains" x')).toThrow();
});
