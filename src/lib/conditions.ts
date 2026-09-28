/**
 * Constrained condition expressions (TypeScript mirror of
 * `orchevia-core/src/conditions.rs`). Keep the grammar in sync:
 * `<variable> <operator> <literal> [and|or ...]` with double-quoted literals.
 */

export type ConditionLogic = 'and' | 'or';

export type ConditionOp =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'greater'
  | 'less'
  | 'greaterOrEqual'
  | 'lessOrEqual';

export interface ConditionClause {
  left: string;
  op: ConditionOp;
  right: string;
}

export interface ConditionConfig {
  logic: ConditionLogic;
  clauses: ConditionClause[];
}

const OP_SYMBOLS: Record<ConditionOp, string> = {
  equals: '==',
  notEquals: '!=',
  contains: 'contains',
  notContains: 'not contains',
  greater: '>',
  less: '<',
  greaterOrEqual: '>=',
  lessOrEqual: '<=',
};

const SYMBOL_OPS: Record<string, ConditionOp> = {
  '==': 'equals',
  '=': 'equals',
  eq: 'equals',
  equals: 'equals',
  '!=': 'notEquals',
  '<>': 'notEquals',
  ne: 'notEquals',
  not_equals: 'notEquals',
  contains: 'contains',
  'not contains': 'notContains',
  '!contains': 'notContains',
  notcontains: 'notContains',
  not_contains: 'notContains',
  '>': 'greater',
  gt: 'greater',
  '<': 'less',
  lt: 'less',
  '>=': 'greaterOrEqual',
  gte: 'greaterOrEqual',
  greater_or_equal: 'greaterOrEqual',
  '<=': 'lessOrEqual',
  lte: 'lessOrEqual',
  less_or_equal: 'lessOrEqual',
};

export function opSymbol(op: ConditionOp): string {
  return OP_SYMBOLS[op];
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let inToken = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inQuotes) {
      if (c === '\\' && i + 1 < text.length) {
        current += text[i + 1] as string;
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        current += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      inToken = true;
    } else if (/\s/.test(c)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
    } else {
      current += c;
      inToken = true;
    }
  }
  if (inQuotes) throw new Error('Condition has an unterminated quote.');
  if (inToken) tokens.push(current);
  return tokens;
}

const REF_PART = '[A-Za-z0-9_-]+';
const REF_PATTERN = new RegExp(`^${REF_PART}(\\.${REF_PART})*$`);

function parseClause(tokens: string[]): ConditionClause {
  // Allow two-word `not contains` operator.
  const normalized: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const lower = (tokens[i] as string).toLowerCase();
    const next = tokens[i + 1];
    if (lower === 'not' && next !== undefined && next.toLowerCase() === 'contains') {
      normalized.push('not contains');
      i++;
    } else {
      normalized.push(tokens[i] as string);
    }
  }
  if (normalized.length < 3) {
    throw new Error(
      `Clause '${normalized.join(' ')}' needs the form \`<variable> <operator> <value>\`.`,
    );
  }
  if (normalized.length > 3) {
    throw new Error(
      `Clause '${normalized.join(' ')}' has extra text. Quote values containing spaces.`,
    );
  }
  const [left = '', opText = '', right = ''] = normalized;
  if (!REF_PATTERN.test(left) || left.length > 128) {
    throw new Error(
      `Left side '${left}' must be a variable like node.review1.severity or input.branch.`,
    );
  }
  const op = SYMBOL_OPS[opText.toLowerCase()];
  if (op === undefined) {
    throw new Error(
      `Unknown operator '${opText}'. Use one of ==, !=, contains, not contains, >, <, >=, <=.`,
    );
  }
  return { left, op, right };
}

/** Parse text into a ConditionConfig. Throws with a human message. */
export function parseCondition(text: string): ConditionConfig {
  const tokens = tokenize(text);
  if (tokens.length === 0) throw new Error('Condition must not be empty.');
  const clauses: ConditionClause[] = [];
  let logic: ConditionLogic | null = null;
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) throw new Error("Condition has a dangling 'and'/'or'.");
    clauses.push(parseClause(current));
    current = [];
  };
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === 'and' || lower === 'or') {
      flush();
      if (logic === null) {
        logic = lower;
      } else if (logic !== lower) {
        throw new Error(
          "Mixing 'and' and 'or' needs explicit grouping, which is not supported.",
        );
      }
      continue;
    }
    current.push(token);
  }
  if (current.length === 0) throw new Error("Condition ends with a dangling 'and'/'or'.");
  clauses.push(parseClause(current));
  return { logic: logic ?? 'and', clauses };
}

function quoteIfNeeded(s: string): string {
  if (s === '' || /[\s"]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

/** Render canonical text for a ConditionConfig. */
export function renderCondition(config: ConditionConfig): string {
  const joiner = config.logic === 'and' ? ' and ' : ' or ';
  return config.clauses
    .map((c) => `${c.left} ${opSymbol(c.op)} ${quoteIfNeeded(c.right)}`)
    .join(joiner);
}

/** Evaluate locally (same semantics as the backend). Throws on unknowns. */
export function evalCondition(
  config: ConditionConfig,
  vars: Record<string, string>,
): boolean {
  if (config.clauses.length === 0) throw new Error('Condition has no clauses.');
  const results = config.clauses.map((clause) => {
    if (!Object.hasOwn(vars, clause.left)) {
      throw new Error(`Unknown variable '${clause.left}'.`);
    }
    const left = vars[clause.left] as string;
    const right = clause.right;
    switch (clause.op) {
      case 'equals':
        return left === right;
      case 'notEquals':
        return left !== right;
      case 'contains':
        return left.includes(right);
      case 'notContains':
        return !left.includes(right);
      case 'greater':
      case 'less':
      case 'greaterOrEqual':
      case 'lessOrEqual': {
        const l = Number(left.trim());
        const r = Number(right.trim());
        if (!Number.isFinite(l)) throw new Error(`'${clause.left}' is not numeric.`);
        if (!Number.isFinite(r)) throw new Error(`Right side '${right}' is not numeric.`);
        if (clause.op === 'greater') return l > r;
        if (clause.op === 'less') return l < r;
        if (clause.op === 'greaterOrEqual') return l >= r;
        return l <= r;
      }
    }
  });
  return config.logic === 'and' ? results.every(Boolean) : results.some(Boolean);
}
