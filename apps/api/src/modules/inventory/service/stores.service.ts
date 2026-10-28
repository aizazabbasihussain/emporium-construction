import { ConflictError } from '@emporium/domain';
import { D, fmtQty } from '@emporium/domain/valuation';
import { scopeFilter } from '@emporium/domain/identity';
import type { StoreKind } from '@emporium/shared';
import {
  assertFound,
  assertKnown,
  assertStockable,
  assertStoreReachable,
} from '../policy/inventory.policy.js';
import {
  findStore,
  findStoreByCode,
  insertStore,
  searchStores,
  upsertReorderLevel,
  type StoreRow,
} from '../repo/inventory.repo.js';
import type { Actor, Db, PageResult, ReorderLevelDto, StoreDto } from '../types.js';
import type { Context } from './context.js';
import { pageOf, requiredText, textOrNull } from './support.js';

export interface StoreInput {
  code: string;
  name: string;
  kind: StoreKind;
  projectId?: string | null | undefined;
  custodianUserId?: string | null | undefined;
}

export const storeDtoOf = (row: StoreRow): StoreDto => ({
  id: row.id,
  code: row.code,
  name: row.name,
  kind: row.kind as StoreKind,
  projectId: row.project_id,
  custodianUserId: row.custodian_user_id,
  active: row.active,
  version: row.version,
});

export type StoresService = ReturnType<typeof createStoresService>;

export function createStoresService(ctx: Context) {
  const { clock, record, projects, masterData } = ctx;

  return {
    async list(
      db: Db,
      query: { active?: boolean | undefined; limit: number; offset: number },
      actor: Actor,
    ): Promise<PageResult<StoreDto>> {
      const scope = scopeFilter(actor, 'project');
      const { rows, total } = await searchStores(db, {
        ...query,
        projectIds: scope.all ? undefined : scope.ids,
      });
      return pageOf(rows.map(storeDtoOf), total, query);
    },

    async get(db: Db, id: string, actor: Actor): Promise<StoreDto> {
      const row = assertFound(await findStore(db, id), 'store');
      assertStoreReachable(actor, { projectId: row.project_id });
      return storeDtoOf(row);
    },

    /** A store is a warehouse, or a site store that may belong to a project. */
    async create(input: StoreInput, actor: Actor, tx: Db): Promise<StoreDto> {
      const code = requiredText(input.code, 'code');
      if ((await findStoreByCode(tx, code)) !== undefined) {
        throw new ConflictError('code_taken', `Store code ${code} is already used`);
      }
      const projectId = input.projectId ?? null;
      assertKnown(
        projectId === null || input.kind === 'site',
        'warehouse_has_project',
        'Only a site store belongs to a project',
      );
      if (projectId !== null) await projects.getProject(tx, projectId);
      const row = await insertStore(
        tx,
        {
          id: ctx.newId(),
          code,
          name: requiredText(input.name, 'name'),
          kind: input.kind,
          project_id: projectId,
          custodian_user_id: textOrNull(input.custodianUserId),
        },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'inventory.store.create',
        entityType: 'inv_store',
        entityId: row.id,
        after: { code: row.code, kind: row.kind },
        event: { type: 'inventory.store.changed', payload: { storeId: row.id, action: 'created' } },
      });
      return storeDtoOf(row);
    },

    /** BR-10: the level below which a store is alerted; a new level clears nothing already alerted. */
    async setReorderLevel(
      input: { storeId: string; itemId: string; level: string },
      actor: Actor,
      tx: Db,
    ): Promise<ReorderLevelDto> {
      const store = assertFound(await findStore(tx, input.storeId), 'store');
      assertStoreReachable(actor, { projectId: store.project_id });
      const item = await masterData.getItem(tx, input.itemId);
      assertKnown(item !== undefined, 'item_not_found', 'The item does not exist');
      assertStockable(item as NonNullable<typeof item>);
      const level = fmtQty(new D(input.level));
      const row = await upsertReorderLevel(tx, {
        storeId: store.id,
        itemId: input.itemId,
        level,
        by: actor.userId,
        at: clock.now(),
      });
      await record(tx, actor, {
        action: 'inventory.reorder_level.set',
        entityType: 'inv_reorder_level',
        entityId: store.id,
        after: { itemId: input.itemId, level },
        event: {
          type: 'inventory.store.changed',
          payload: { storeId: store.id, action: 'reorder_level' },
        },
      });
      return { storeId: row.store_id, itemId: row.item_id, level: row.level };
    },
  };
}
