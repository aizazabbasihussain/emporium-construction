import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import { D, fmtMoney, fmtQty, waAverage, ZERO } from '@emporium/domain/valuation';
import type { ValuationMethod } from '@emporium/shared';
import {
  listKeyValues,
  searchMovements,
  searchTransitions,
  type MovementSearch,
} from '../repo/valuation.repo.js';
import type {
  Db,
  MovementDto,
  PageResult,
  StockValueDto,
  StockValueReport,
  TransitionDto,
} from '../types.js';
import { toTransitionDto } from './ledger.service.js';
import type { PoliciesService } from './policies.service.js';
import { resultOf } from './results.js';

export interface StockValueFilter {
  storeId?: string | undefined;
  itemId?: string | undefined;
  /** A category, including everything below it in the tree. */
  categoryId?: string | undefined;
}

export interface ReportsService {
  /** BR-13: quantity and value per store and item, with the method each is kept in. */
  getTotalValue(db: Db, filter: StockValueFilter): Promise<StockValueReport>;
  /** Value of one key; a key valuation has never seen is empty, in the method that applies today. */
  getStockValue(db: Db, storeId: string, itemId: string): Promise<StockValueDto>;
  movements(db: Db, search: MovementSearch): Promise<PageResult<MovementDto>>;
  transitions(db: Db, page: { limit: number; offset: number }): Promise<PageResult<TransitionDto>>;
}

export function createReportsService(deps: {
  clock: Clock;
  policies: Pick<PoliciesService, 'categoryChain' | 'resolvePolicy'>;
}): ReportsService {
  const { clock, policies } = deps;

  async function getTotalValue(db: Db, filter: StockValueFilter): Promise<StockValueReport> {
    const chains = new Map<string, string[]>();
    const items: StockValueDto[] = [];
    let total = ZERO;
    for (const row of await listKeyValues(db, filter)) {
      let chain = chains.get(row.item_id);
      if (chain === undefined) {
        chain = await policies.categoryChain(db, row.item_id);
        chains.set(row.item_id, chain);
      }
      if (filter.categoryId !== undefined && !chain.includes(filter.categoryId)) continue;
      const state = { quantity: new D(row.quantity), totalValue: new D(row.value) };
      total = total.plus(state.totalValue);
      items.push({
        storeId: row.store_id,
        itemId: row.item_id,
        categoryId: chain[0] ?? null,
        method: row.method as ValuationMethod,
        quantity: fmtQty(state.quantity),
        value: fmtMoney(state.totalValue),
        averageCost: waAverage(state),
      });
    }
    return { items, totalValue: fmtMoney(total) };
  }

  return {
    getTotalValue,

    async getStockValue(db, storeId, itemId) {
      const [found] = (await getTotalValue(db, { storeId, itemId })).items;
      if (found) return found;
      const policy = await policies.resolvePolicy(db, itemId, BusinessDate.today(clock).toString());
      return {
        storeId,
        itemId,
        categoryId: (await policies.categoryChain(db, itemId))[0] ?? null,
        method: policy.method,
        quantity: '0.0000',
        value: '0.00',
        averageCost: '0.0000',
      };
    },

    async movements(db, search) {
      const { rows, total } = await searchMovements(db, search);
      const items: MovementDto[] = [];
      for (const row of rows) {
        items.push({
          ...(await resultOf(db, row)),
          postingDate: row.posting_date,
          sourceRef: row.source_ref,
          issueMovementId: row.issue_movement_id,
          createdAt: row.created_at.toISOString(),
        });
      }
      return { items, total, limit: search.limit, offset: search.offset };
    },

    async transitions(db, page) {
      const { rows, total } = await searchTransitions(db, page);
      return { items: rows.map(toTransitionDto), total, limit: page.limit, offset: page.offset };
    },
  };
}
