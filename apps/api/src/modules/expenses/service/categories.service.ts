import { nonNegativeAmount } from '@emporium/domain/expenses';
import { ValidationError } from '@emporium/domain';
import {
  findCategory,
  listCategories,
  upsertCategory,
  type CategoryRow,
} from '../repo/expenses.repo.js';
import type { Actor, CategoryDto, Db } from '../types.js';
import type { Context } from './context.js';
import { requiredText } from './support.js';

export interface CategoryInput {
  code: string;
  name: string;
  defaultCostCodeId?: string | null | undefined;
  receiptRequired: boolean;
  maxWithoutReceipt: string;
}

const categoryOf = (row: CategoryRow): CategoryDto => ({
  code: row.code,
  name: row.name,
  defaultCostCodeId: row.default_cost_code_id,
  receiptRequired: row.receipt_required,
  maxWithoutReceipt: row.max_without_receipt,
  version: row.version,
});

export type CategoryService = ReturnType<typeof createCategoryService>;

export function createCategoryService(ctx: Context) {
  return {
    async list(db: Db): Promise<CategoryDto[]> {
      return (await listCategories(db)).map(categoryOf);
    },

    /** `PUT /expenses/categories`: adds or changes the listed categories. */
    async save(inputs: readonly CategoryInput[], actor: Actor, tx: Db): Promise<CategoryDto[]> {
      const codes = inputs.map((input) => input.code);
      if (new Set(codes).size !== codes.length) {
        throw new ValidationError('category_duplicate', 'A category is listed twice');
      }
      for (const input of inputs) {
        const defaultCostCodeId = input.defaultCostCodeId ?? null;
        if (defaultCostCodeId !== null) await ctx.checkCostCode(tx, defaultCostCodeId);
        const before = await findCategory(tx, input.code);
        const row = await upsertCategory(
          tx,
          {
            code: input.code,
            name: requiredText(input.name, 'name'),
            defaultCostCodeId,
            receiptRequired: input.receiptRequired,
            maxWithoutReceipt: nonNegativeAmount(input.maxWithoutReceipt, 'max_without_receipt'),
          },
          actor.userId,
          ctx.clock.now(),
        );
        await ctx.record(tx, actor, {
          action: 'expenses.category.save',
          entityType: 'exp_category',
          entityId: input.code,
          before: before === undefined ? undefined : categoryOf(before),
          after: categoryOf(row),
          event: { type: 'expenses.category.changed', payload: { code: row.code } },
        });
      }
      return (await listCategories(tx)).map(categoryOf);
    },
  };
}
