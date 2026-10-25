import { describe, expect, it } from 'vitest';
import { createReferences } from './references.service.js';
import {
  normalizedOrNull,
  pageOf,
  paginateList,
  requiredText,
  textOrNull,
  type ListQuery,
} from './support.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('text helpers', () => {
  it('trims text and turns empty text into null', () => {
    expect(textOrNull('  a ')).toBe('a');
    expect(textOrNull('   ')).toBeNull();
    expect(textOrNull(null)).toBeNull();
    expect(textOrNull(undefined)).toBeNull();
    expect(requiredText(' b ', 'name')).toBe('b');
    expect(codeOf(() => requiredText(' ', 'name'))).toBe('name_required');
    expect(normalizedOrNull(' x ', (v) => v.toUpperCase())).toBe('X');
    expect(normalizedOrNull('', (v) => v.toUpperCase())).toBeNull();
  });

  it('describes a page', () => {
    expect(pageOf([1], 5, { limit: 1, offset: 2 })).toEqual({
      items: [1],
      total: 5,
      limit: 1,
      offset: 2,
    });
  });
});

describe('paginateList', () => {
  const rows = [
    { code: 'b', name: 'Beta', note: null },
    { code: 'a', name: 'Alpha', note: 'first' },
    { code: 'c', name: 'Gamma', note: null },
  ];
  const run = (query: Partial<ListQuery>) =>
    paginateList(
      rows,
      { direction: 'asc', limit: 50, offset: 0, ...query },
      (r) => [r.code, r.name, r.note],
      { code: (r) => r.code, name: (r) => r.name },
    );

  it('keeps the natural order without a known sort', () => {
    expect(run({}).items.map((r) => r.code)).toEqual(['b', 'a', 'c']);
    expect(run({ sort: 'unknown' }).items.map((r) => r.code)).toEqual(['b', 'a', 'c']);
  });

  it('sorts in both directions', () => {
    expect(run({ sort: 'code' }).items.map((r) => r.code)).toEqual(['a', 'b', 'c']);
    expect(run({ sort: 'name', direction: 'desc' }).items.map((r) => r.name)).toEqual([
      'Gamma',
      'Beta',
      'Alpha',
    ]);
  });

  it('searches every field, ignoring case and null fields', () => {
    expect(run({ q: ' ALPH ' }).items.map((r) => r.code)).toEqual(['a']);
    expect(run({ q: 'first' }).items.map((r) => r.code)).toEqual(['a']);
    expect(run({ q: '   ' }).total).toBe(3);
    expect(run({ q: 'nothing' })).toMatchObject({ items: [], total: 0 });
  });

  it('pages after filtering', () => {
    expect(run({ sort: 'code', limit: 2, offset: 1 })).toEqual({
      items: [rows[0], rows[2]],
      total: 3,
      limit: 2,
      offset: 1,
    });
  });
});

describe('references (BR-6, BR-8)', () => {
  const db = {} as never;

  it('is not referenced until a module registers a check, and any check can say yes', async () => {
    const references = createReferences();
    expect(await references.isReferenced(db, 'party', 'p1')).toBe(false);
    references.registerReferenceCheck('party', () => Promise.resolve(false));
    expect(await references.isReferenced(db, 'party', 'p1')).toBe(false);
    references.registerReferenceCheck('party', (_db, id) => Promise.resolve(id === 'p1'));
    expect(await references.isReferenced(db, 'party', 'p1')).toBe(true);
    expect(await references.isReferenced(db, 'item', 'p1')).toBe(false);
  });

  it('assumes no posted costs until the ledger registers, and accepts one registration', async () => {
    const references = createReferences();
    expect(await references.costCodeUsage(db, 'c1')).toEqual({
      postedCosts: false,
      openBudgetLines: false,
    });
    references.registerCostCodeUsage(() =>
      Promise.resolve({ postedCosts: true, openBudgetLines: false }),
    );
    expect(await references.costCodeUsage(db, 'c1')).toEqual({
      postedCosts: true,
      openBudgetLines: false,
    });
    expect(
      codeOf(() => references.registerCostCodeUsage(() => Promise.reject(new Error('x')))),
    ).toBe('cost_code_usage_registered');
  });
});
