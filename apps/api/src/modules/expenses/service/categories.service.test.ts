import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTANT, auditCount, createExpensesKit, type ExpensesKit } from '../test-support.js';

let kit: ExpensesKit;
beforeAll(async () => {
  kit = await createExpensesKit();
}, 60_000);
afterAll(() => kit.close());

const accountant = () => kit.actorFor(ACCOUNTANT);
const code = (error: string) => expect.objectContaining({ code: error }) as Error;
const save = (categories: Parameters<typeof kit.expenses.categories.save>[0]) =>
  kit.db.transaction((tx) => kit.expenses.categories.save(categories, accountant(), tx));

describe('expense categories', () => {
  it('lists the categories', async () => {
    expect((await kit.expenses.categories.list(kit.db)).map((c) => c.code)).toEqual(['transport']);
  });

  it('adds and changes categories with their receipt rule', async () => {
    const before = await auditCount(kit.db, 'expenses.category.save');
    const added = await save([
      {
        code: 'food',
        name: '  Food  ',
        defaultCostCodeId: kit.codes['500'],
        receiptRequired: true,
        maxWithoutReceipt: '250.5',
      },
    ]);
    expect(added.find((c) => c.code === 'food')).toMatchObject({
      name: 'Food',
      defaultCostCodeId: kit.codes['500'],
      receiptRequired: true,
      maxWithoutReceipt: '250.50',
      version: 1,
    });
    const changed = await save([
      { code: 'food', name: 'Meals', receiptRequired: false, maxWithoutReceipt: '0' },
    ]);
    expect(changed.find((c) => c.code === 'food')).toMatchObject({
      name: 'Meals',
      defaultCostCodeId: null,
      receiptRequired: false,
      version: 2,
    });
    expect(await auditCount(kit.db, 'expenses.category.save')).toBe(before + 2);
  });

  it('rejects a repeated code, an inactive default cost code and bad values', async () => {
    const base = { name: 'X', receiptRequired: false, maxWithoutReceipt: '0' };
    await expect(
      save([
        { code: 'a', ...base },
        { code: 'a', ...base },
      ]),
    ).rejects.toThrow(code('category_duplicate'));
    await expect(
      save([{ code: 'a', ...base, defaultCostCodeId: kit.inactiveCode }]),
    ).rejects.toThrow(code('cost_code_inactive'));
    await expect(save([{ code: 'a', ...base, name: ' ' }])).rejects.toThrow(code('name_required'));
    await expect(save([{ code: 'a', ...base, maxWithoutReceipt: '-1' }])).rejects.toThrow(
      code('max_without_receipt_invalid'),
    );
  });
});
