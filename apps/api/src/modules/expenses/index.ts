// The only public entry point of the expenses module.
import { expenseClaimEntityType } from '@emporium/shared';
import { canAccessReceipt } from './policy/expenses.policy.js';
import { subscribeToDecisions } from './service/approval-events.service.js';
import { createAdvanceService, type AdvanceService } from './service/advances.service.js';
import { createCategoryService, type CategoryService } from './service/categories.service.js';
import { createClaimService, type ClaimService } from './service/claims.service.js';
import { createContext, type ExpensesDeps } from './service/context.js';

export interface Expenses {
  claims: ClaimService;
  advances: AdvanceService;
  categories: CategoryService;
  /** Query interface for other modules (spec P1-14 section 2, BR-1). */
  getCustodianBalance: AdvanceService['balance'];
}

/**
 * Wires expenses on top of the kernel, projects, approvals, master data, files and identity.
 * Reacts to the approval engine's decisions and registers the access rule for receipts.
 */
export function createExpenses(deps: ExpensesDeps): Expenses {
  const ctx = createContext(deps);
  const claims = createClaimService(ctx);
  const advances = createAdvanceService(ctx);
  const categories = createCategoryService(ctx);
  subscribeToDecisions({ platform: deps.platform, claims });
  deps.files.registerFileAccess(
    expenseClaimEntityType,
    async ({ actor, entityId, operation, db }) =>
      canAccessReceipt({
        userId: actor.userId,
        permissions: actor.permissions,
        operation,
        claimantId: await claims.claimantOf(db, entityId),
      }),
    // A receipt backs a cost entry: its files are kept after removal.
    { retainForever: true },
  );
  return { claims, advances, categories, getCustodianBalance: advances.balance };
}

export { registerExpensesRoutes, type ExpensesRouteDeps } from './routes/expenses.routes.js';
export type {
  AdvanceDto,
  CategoryDto,
  ClaimDto,
  ClaimHeaderDto,
  ClaimLineDto,
  CustodianDto,
} from './types.js';
