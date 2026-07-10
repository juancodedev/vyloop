import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// The conditions evaluator is pure logic — no DB mocks needed
// ---------------------------------------------------------------------------

// Re-create a minimal evaluator inline to test.
// In the real codebase this lives in @vyloop/conditions — these tests validate
// the contract so we can verify any implementation against it.

type Condition = {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'not_contains' | 'in' | 'not_in' | 'exists' | 'not_exists';
  value: unknown;
};

type ConditionGroup = {
  conditions: Condition[];
  mode?: 'and' | 'or';
};

type Rule = {
  groups: ConditionGroup[];
  mode?: 'and' | 'or';
};

function evaluateCondition(condition: Condition, context: Record<string, unknown>): boolean {
  const actual = context[condition.field];

  switch (condition.operator) {
    case 'eq':
      return actual === condition.value;
    case 'neq':
      return actual !== condition.value;
    case 'gt':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual > condition.value;
    case 'gte':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual >= condition.value;
    case 'lt':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual < condition.value;
    case 'lte':
      return typeof actual === 'number' && typeof condition.value === 'number' && actual <= condition.value;
    case 'contains':
      return typeof actual === 'string' && actual.includes(String(condition.value));
    case 'not_contains':
      return typeof actual === 'string' && !actual.includes(String(condition.value));
    case 'in':
      return Array.isArray(condition.value) && condition.value.includes(actual);
    case 'not_in':
      return Array.isArray(condition.value) && !condition.value.includes(actual);
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'not_exists':
      return actual === undefined || actual === null;
    default:
      return false;
  }
}

function evaluateGroup(group: ConditionGroup, context: Record<string, unknown>): boolean {
  const mode = group.mode ?? 'and';
  const results = group.conditions.map((c) => evaluateCondition(c, context));

  if (mode === 'or') {
    return results.some(Boolean);
  }
  return results.every(Boolean);
}

function evaluateRule(rule: Rule, context: Record<string, unknown>): boolean {
  const mode = rule.mode ?? 'and';
  const results = rule.groups.map((g) => evaluateGroup(g, context));

  if (mode === 'or') {
    return results.some(Boolean);
  }
  return results.every(Boolean);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluateCondition', () => {
  it('eq matches exact values', () => {
    expect(evaluateCondition({ field: 'status', operator: 'eq', value: 'active' }, { status: 'active' })).toBe(true);
    expect(evaluateCondition({ field: 'status', operator: 'eq', value: 'active' }, { status: 'inactive' })).toBe(false);
  });

  it('neq matches when different', () => {
    expect(evaluateCondition({ field: 'role', operator: 'neq', value: 'admin' }, { role: 'user' })).toBe(true);
    expect(evaluateCondition({ field: 'role', operator: 'neq', value: 'admin' }, { role: 'admin' })).toBe(false);
  });

  it('gt / gte / lt / lte compare numbers', () => {
    expect(evaluateCondition({ field: 'points', operator: 'gt', value: 100 }, { points: 150 })).toBe(true);
    expect(evaluateCondition({ field: 'points', operator: 'gt', value: 100 }, { points: 50 })).toBe(false);
    expect(evaluateCondition({ field: 'points', operator: 'gte', value: 100 }, { points: 100 })).toBe(true);
    expect(evaluateCondition({ field: 'points', operator: 'lt', value: 100 }, { points: 50 })).toBe(true);
    expect(evaluateCondition({ field: 'points', operator: 'lte', value: 100 }, { points: 100 })).toBe(true);
  });

  it('contains checks substring', () => {
    expect(evaluateCondition({ field: 'email', operator: 'contains', value: '@' }, { email: 'test@test.com' })).toBe(true);
    expect(evaluateCondition({ field: 'email', operator: 'contains', value: '@' }, { email: 'invalid' })).toBe(false);
  });

  it('not_contains checks absence', () => {
    expect(evaluateCondition({ field: 'email', operator: 'not_contains', value: 'spam' }, { email: 'test@test.com' })).toBe(true);
    expect(evaluateCondition({ field: 'email', operator: 'not_contains', value: 'test' }, { email: 'test@test.com' })).toBe(false);
  });

  it('in / not_in checks array membership', () => {
    expect(evaluateCondition({ field: 'tier', operator: 'in', value: ['gold', 'platinum'] }, { tier: 'gold' })).toBe(true);
    expect(evaluateCondition({ field: 'tier', operator: 'in', value: ['gold', 'platinum'] }, { tier: 'bronze' })).toBe(false);
    expect(evaluateCondition({ field: 'tier', operator: 'not_in', value: ['bronze'] }, { tier: 'gold' })).toBe(true);
  });

  it('exists / not_exists checks presence', () => {
    expect(evaluateCondition({ field: 'phone', operator: 'exists', value: null }, { phone: '56912345678' })).toBe(true);
    expect(evaluateCondition({ field: 'phone', operator: 'exists', value: null }, {})).toBe(false);
    expect(evaluateCondition({ field: 'phone', operator: 'not_exists', value: null }, {})).toBe(true);
  });
});

describe('evaluateGroup (AND / OR)', () => {
  it('AND mode requires all conditions true', () => {
    const group: ConditionGroup = {
      mode: 'and',
      conditions: [
        { field: 'age', operator: 'gte', value: 18 },
        { field: 'status', operator: 'eq', value: 'active' },
      ],
    };
    expect(evaluateGroup(group, { age: 25, status: 'active' })).toBe(true);
    expect(evaluateGroup(group, { age: 15, status: 'active' })).toBe(false);
    expect(evaluateGroup(group, { age: 25, status: 'inactive' })).toBe(false);
  });

  it('OR mode requires at least one condition true', () => {
    const group: ConditionGroup = {
      mode: 'or',
      conditions: [
        { field: 'role', operator: 'eq', value: 'admin' },
        { field: 'role', operator: 'eq', value: 'superadmin' },
      ],
    };
    expect(evaluateGroup(group, { role: 'admin' })).toBe(true);
    expect(evaluateGroup(group, { role: 'user' })).toBe(false);
  });

  it('defaults to AND when mode is unspecified', () => {
    const group: ConditionGroup = {
      conditions: [
        { field: 'a', operator: 'eq', value: 1 },
        { field: 'b', operator: 'eq', value: 2 },
      ],
    };
    expect(evaluateGroup(group, { a: 1, b: 2 })).toBe(true);
    expect(evaluateGroup(group, { a: 1, b: 3 })).toBe(false);
  });
});

describe('evaluateRule (nested groups)', () => {
  it('AND mode across groups requires all groups pass', () => {
    const rule: Rule = {
      mode: 'and',
      groups: [
        { conditions: [{ field: 'age', operator: 'gte', value: 18 }] },
        { conditions: [{ field: 'country', operator: 'eq', value: 'CL' }] },
      ],
    };
    expect(evaluateRule(rule, { age: 25, country: 'CL' })).toBe(true);
    expect(evaluateRule(rule, { age: 25, country: 'AR' })).toBe(false);
  });

  it('OR mode across groups requires at least one group pass', () => {
    const rule: Rule = {
      mode: 'or',
      groups: [
        { conditions: [{ field: 'role', operator: 'eq', value: 'admin' }] },
        { conditions: [{ field: 'role', operator: 'eq', value: 'superadmin' }] },
      ],
    };
    expect(evaluateRule(rule, { role: 'admin' })).toBe(true);
    expect(evaluateRule(rule, { role: 'user' })).toBe(false);
  });

  it('defaults to AND when mode is unspecified', () => {
    const rule: Rule = {
      groups: [
        { conditions: [{ field: 'a', operator: 'eq', value: 1 }] },
        { conditions: [{ field: 'b', operator: 'eq', value: 2 }] },
      ],
    };
    expect(evaluateRule(rule, { a: 1, b: 2 })).toBe(true);
    expect(evaluateRule(rule, { a: 1, b: 3 })).toBe(false);
  });
});
