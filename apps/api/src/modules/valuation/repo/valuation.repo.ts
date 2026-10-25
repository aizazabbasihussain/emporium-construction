import type { Db } from '../types.js';

// SQL access for the valuation module. No business rules here (constitution 3). Numbers are read as
// text so no float ever appears; sequences and dates are cast to text for the same reason.

export interface PolicyRow {
  id: string;
  scope: string;
  category_id: string | null;
  method: string;
  effective_from: string;
  status: string;
  requested_by: string | null;
  approved_by: string | null;
  created_at: Date;
}

export interface KeyRow {
  store_id: string;
  item_id: string;
  method: string;
  last_posting_date: string | null;
}

export interface WaRow {
  quantity: string;
  total_value: string;
}

export interface LayerRow {
  id: string;
  received_seq: string;
  remaining_qty: string;
  remaining_value: string;
  unit_cost: string;
}

export interface MovementRow {
  id: string;
  seq: string;
  store_id: string;
  item_id: string;
  type: string;
  quantity: string;
  value: string;
  unit_cost: string;
  method_used: string;
  posting_date: string;
  source_ref: string | null;
  issue_movement_id: string | null;
  idempotency_key: string;
  created_at: Date;
}

export interface ConsumptionRow {
  id: string;
  part_no: number;
  layer_id: string | null;
  layer_received_seq: string | null;
  quantity: string;
  unit_cost: string;
  value: string;
}

export interface ReturnableRow extends ConsumptionRow {
  returned_qty: string;
  returned_value: string;
}

export interface TransitionRow {
  id: string;
  store_id: string;
  item_id: string;
  from_method: string;
  to_method: string;
  qty: string;
  value_before: string;
  value_after: string;
  policy_id: string;
  completed_at: Date;
}

export interface KeyValueRow {
  store_id: string;
  item_id: string;
  method: string;
  quantity: string;
  value: string;
}

// Policies -------------------------------------------------------------------------------------

const POLICY_COLUMNS = `id, scope, category_id, method, to_char(effective_from, 'YYYY-MM-DD') as effective_from,
  status, requested_by, approved_by, created_at`;

export const listPolicies = (db: Db, status?: string) =>
  db.query<PolicyRow>(
    `select ${POLICY_COLUMNS} from val_policies
      where ($1::text is null or status = $1)
      order by effective_from desc, created_at desc, id`,
    [status ?? null],
  );

export async function findPolicy(db: Db, id: string, lock = false): Promise<PolicyRow | undefined> {
  const rows = await db.query<PolicyRow>(
    `select ${POLICY_COLUMNS} from val_policies where id = $1 ${lock ? 'for update' : ''}`,
    [id],
  );
  return rows[0];
}

export async function insertPolicy(
  db: Db,
  policy: {
    id: string;
    scope: string;
    categoryId: string | null;
    method: string;
    effectiveFrom: string;
    requestedBy: string;
    at: Date;
  },
): Promise<PolicyRow> {
  const rows = await db.query<PolicyRow>(
    `insert into val_policies (id, scope, category_id, method, effective_from, status, requested_by, created_at)
     values ($1, $2, $3, $4, $5, 'pending_approval', $6, $7)
     returning ${POLICY_COLUMNS}`,
    [
      policy.id,
      policy.scope,
      policy.categoryId,
      policy.method,
      policy.effectiveFrom,
      policy.requestedBy,
      policy.at.toISOString(),
    ],
  );
  return rows[0] as PolicyRow;
}

/** BR-3: replaces any active policy with the same scope key and start date. */
export const supersedeSameStart = (
  db: Db,
  policy: { id: string; scope: string; categoryId: string | null; effectiveFrom: string },
) =>
  db.query(
    `update val_policies set status = 'superseded'
      where status = 'active' and id <> $1 and scope = $2 and effective_from = $4
        and category_id is not distinct from $3`,
    [policy.id, policy.scope, policy.categoryId, policy.effectiveFrom],
  );

export const decidePolicy = (
  db: Db,
  id: string,
  decision: { status: 'active' | 'rejected'; effectiveFrom: string; approvedBy: string | null },
) =>
  db.query(
    `update val_policies set status = $2, effective_from = $3, approved_by = $4 where id = $1`,
    [id, decision.status, decision.effectiveFrom, decision.approvedBy],
  );

// Keys -----------------------------------------------------------------------------------------

const KEY_COLUMNS = `store_id, item_id, method, to_char(last_posting_date, 'YYYY-MM-DD') as last_posting_date`;

/** Creates the key in `method` if it is new, then locks it for the rest of the transaction. */
export async function lockKey(
  db: Db,
  storeId: string,
  itemId: string,
  method: string,
): Promise<KeyRow> {
  await db.query(
    `insert into val_keys (store_id, item_id, method) values ($1, $2, $3)
     on conflict (store_id, item_id) do nothing`,
    [storeId, itemId, method],
  );
  await db.query(
    `insert into val_wa_state (store_id, item_id) values ($1, $2)
     on conflict (store_id, item_id) do nothing`,
    [storeId, itemId],
  );
  const rows = await db.query<KeyRow>(
    `select ${KEY_COLUMNS} from val_keys where store_id = $1 and item_id = $2 for update`,
    [storeId, itemId],
  );
  return rows[0] as KeyRow;
}

/** Locks existing keys in a fixed order so opposite transfers cannot wait for each other. */
export async function lockExistingKeys(
  db: Db,
  keys: readonly { storeId: string; itemId: string }[],
): Promise<void> {
  const ordered = [...keys].sort((a, b) =>
    `${a.storeId}:${a.itemId}`.localeCompare(`${b.storeId}:${b.itemId}`),
  );
  for (const key of ordered) {
    await db.query('select 1 from val_keys where store_id = $1 and item_id = $2 for update', [
      key.storeId,
      key.itemId,
    ]);
  }
}

export const listKeys = (db: Db) =>
  db.query<KeyRow>(`select ${KEY_COLUMNS} from val_keys order by store_id, item_id`);

export const touchKey = (db: Db, storeId: string, itemId: string, method: string, date: string) =>
  db.query(
    `update val_keys set method = $3, last_posting_date = $4 where store_id = $1 and item_id = $2`,
    [storeId, itemId, method, date],
  );

// Weighted-average state and layers ------------------------------------------------------------

export async function getWaState(db: Db, storeId: string, itemId: string): Promise<WaRow> {
  const rows = await db.query<WaRow>(
    `select quantity::text as quantity, total_value::text as total_value from val_wa_state
      where store_id = $1 and item_id = $2`,
    [storeId, itemId],
  );
  return rows[0] as WaRow;
}

export const saveWaState = (
  db: Db,
  storeId: string,
  itemId: string,
  state: { quantity: string; totalValue: string; seq: number },
) =>
  db.query(
    `update val_wa_state set quantity = $3, total_value = $4, updated_seq = $5
      where store_id = $1 and item_id = $2`,
    [storeId, itemId, state.quantity, state.totalValue, state.seq],
  );

const LAYER_COLUMNS = `id, received_seq::text as received_seq, remaining_qty::text as remaining_qty,
  remaining_value::text as remaining_value, unit_cost::text as unit_cost`;

export const listOpenLayers = (db: Db, storeId: string, itemId: string) =>
  db.query<LayerRow>(
    `select ${LAYER_COLUMNS} from val_layers
      where store_id = $1 and item_id = $2 and remaining_qty > 0
      order by received_seq, id`,
    [storeId, itemId],
  );

export const insertLayer = (
  db: Db,
  layer: {
    id: string;
    storeId: string;
    itemId: string;
    receiptRef: string | null;
    receivedSeq: number;
    quantity: string;
    value: string;
    unitCost: string;
    at: Date;
  },
) =>
  db.query(
    `insert into val_layers (id, store_id, item_id, receipt_ref, received_seq, remaining_qty,
                             remaining_value, unit_cost, original_qty, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $6, $9)`,
    [
      layer.id,
      layer.storeId,
      layer.itemId,
      layer.receiptRef,
      layer.receivedSeq,
      layer.quantity,
      layer.value,
      layer.unitCost,
      layer.at.toISOString(),
    ],
  );

export const updateLayer = (db: Db, id: string, remainingQty: string, remainingValue: string) =>
  db.query('update val_layers set remaining_qty = $2, remaining_value = $3 where id = $1', [
    id,
    remainingQty,
    remainingValue,
  ]);

/** The value held by a key under either method, as exact text. */
export async function keyValue(db: Db, storeId: string, itemId: string): Promise<string> {
  const rows = await db.query<{ value: string }>(
    `select ((select total_value from val_wa_state where store_id = $1 and item_id = $2)
           + coalesce((select sum(remaining_value) from val_layers
                        where store_id = $1 and item_id = $2), 0))::text as value`,
    [storeId, itemId],
  );
  return (rows[0] as { value: string }).value;
}

// Movements ------------------------------------------------------------------------------------

const MOVEMENT_COLUMNS = `id, seq::text as seq, store_id, item_id, type, quantity::text as quantity,
  value::text as value, unit_cost::text as unit_cost, method_used,
  to_char(posting_date, 'YYYY-MM-DD') as posting_date, source_ref, issue_movement_id,
  idempotency_key, created_at`;

export async function findMovementByKey(
  db: Db,
  idempotencyKey: string,
): Promise<MovementRow | undefined> {
  const rows = await db.query<MovementRow>(
    `select ${MOVEMENT_COLUMNS} from val_movements where idempotency_key = $1`,
    [idempotencyKey],
  );
  return rows[0];
}

export async function findMovement(db: Db, id: string): Promise<MovementRow | undefined> {
  const rows = await db.query<MovementRow>(
    `select ${MOVEMENT_COLUMNS} from val_movements where id = $1`,
    [id],
  );
  return rows[0];
}

export async function insertMovement(
  db: Db,
  movement: {
    id: string;
    storeId: string;
    itemId: string;
    type: string;
    quantity: string;
    value: string;
    unitCost: string;
    method: string;
    postingDate: string;
    sourceRef: string | null;
    issueMovementId: string | null;
    idempotencyKey: string;
    by: string;
    at: Date;
  },
): Promise<MovementRow> {
  const rows = await db.query<MovementRow>(
    `insert into val_movements (id, store_id, item_id, type, quantity, value, unit_cost, method_used,
                                posting_date, source_ref, issue_movement_id, idempotency_key,
                                created_at, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning ${MOVEMENT_COLUMNS}`,
    [
      movement.id,
      movement.storeId,
      movement.itemId,
      movement.type,
      movement.quantity,
      movement.value,
      movement.unitCost,
      movement.method,
      movement.postingDate,
      movement.sourceRef,
      movement.issueMovementId,
      movement.idempotencyKey,
      movement.at.toISOString(),
      movement.by,
    ],
  );
  return rows[0] as MovementRow;
}

export interface MovementSearch {
  storeId?: string | undefined;
  itemId?: string | undefined;
  type?: string | undefined;
  limit: number;
  offset: number;
}

export async function searchMovements(
  db: Db,
  search: MovementSearch,
): Promise<{ rows: MovementRow[]; total: number }> {
  const filter = `($1::uuid is null or store_id = $1) and ($2::uuid is null or item_id = $2)
                  and ($3::text is null or type = $3)`;
  const params = [search.storeId ?? null, search.itemId ?? null, search.type ?? null];
  const rows = await db.query<MovementRow>(
    `select ${MOVEMENT_COLUMNS} from val_movements where ${filter}
      order by seq desc limit $4 offset $5`,
    [...params, search.limit, search.offset],
  );
  const [count] = await db.query<{ n: string }>(
    `select count(*) as n from val_movements where ${filter}`,
    params,
  );
  return { rows, total: Number(count?.n ?? 0) };
}

export const insertConsumption = (
  db: Db,
  part: {
    id: string;
    movementId: string;
    partNo: number;
    layerId: string | null;
    layerReceivedSeq: number | null;
    quantity: string;
    unitCost: string;
    value: string;
  },
) =>
  db.query(
    `insert into val_consumptions (id, movement_id, part_no, layer_id, layer_received_seq, quantity,
                                   unit_cost, value)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      part.id,
      part.movementId,
      part.partNo,
      part.layerId,
      part.layerReceivedSeq,
      part.quantity,
      part.unitCost,
      part.value,
    ],
  );

const CONSUMPTION_COLUMNS = `id, part_no, layer_id, layer_received_seq::text as layer_received_seq,
  quantity::text as quantity, unit_cost::text as unit_cost, value::text as value`;

export const listConsumptions = (db: Db, movementId: string) =>
  db.query<ConsumptionRow>(
    `select ${CONSUMPTION_COLUMNS} from val_consumptions where movement_id = $1 order by part_no`,
    [movementId],
  );

/** The parts of an issue with what has come back so far (BR-9). */
export const listReturnableParts = (db: Db, issueMovementId: string) =>
  db.query<ReturnableRow>(
    `select c.id, c.part_no, c.layer_id, c.layer_received_seq::text as layer_received_seq,
            c.quantity::text as quantity, c.unit_cost::text as unit_cost, c.value::text as value,
            coalesce(sum(r.quantity), 0)::text as returned_qty,
            coalesce(sum(r.value), 0)::text as returned_value
       from val_consumptions c
       left join val_return_parts r on r.consumption_id = c.id
      where c.movement_id = $1
      group by c.id
      order by c.part_no`,
    [issueMovementId],
  );

export const insertReturnPart = (
  db: Db,
  part: { id: string; movementId: string; consumptionId: string; quantity: string; value: string },
) =>
  db.query(
    `insert into val_return_parts (id, movement_id, consumption_id, quantity, value)
     values ($1, $2, $3, $4, $5)`,
    [part.id, part.movementId, part.consumptionId, part.quantity, part.value],
  );

// Transitions ----------------------------------------------------------------------------------

const TRANSITION_COLUMNS = `id, store_id, item_id, from_method, to_method, qty::text as qty,
  value_before::text as value_before, value_after::text as value_after, policy_id, completed_at`;

export async function insertTransition(
  db: Db,
  transition: {
    id: string;
    storeId: string;
    itemId: string;
    fromMethod: string;
    toMethod: string;
    quantity: string;
    valueBefore: string;
    valueAfter: string;
    policyId: string;
    at: Date;
  },
): Promise<TransitionRow> {
  const rows = await db.query<TransitionRow>(
    `insert into val_transitions (id, store_id, item_id, from_method, to_method, qty, value_before,
                                  value_after, policy_id, completed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning ${TRANSITION_COLUMNS}`,
    [
      transition.id,
      transition.storeId,
      transition.itemId,
      transition.fromMethod,
      transition.toMethod,
      transition.quantity,
      transition.valueBefore,
      transition.valueAfter,
      transition.policyId,
      transition.at.toISOString(),
    ],
  );
  return rows[0] as TransitionRow;
}

export async function searchTransitions(
  db: Db,
  page: { limit: number; offset: number },
): Promise<{ rows: TransitionRow[]; total: number }> {
  const rows = await db.query<TransitionRow>(
    `select ${TRANSITION_COLUMNS} from val_transitions order by completed_at desc, id limit $1 offset $2`,
    [page.limit, page.offset],
  );
  const [count] = await db.query<{ n: string }>('select count(*) as n from val_transitions');
  return { rows, total: Number(count?.n ?? 0) };
}

// Reports --------------------------------------------------------------------------------------

/** Quantity and value of every key under either method (BR-13). */
export const listKeyValues = (db: Db, filter: { storeId?: string; itemId?: string }) =>
  db.query<KeyValueRow>(
    `select k.store_id, k.item_id, k.method,
            (w.quantity + coalesce((select sum(remaining_qty) from val_layers l
                                     where l.store_id = k.store_id and l.item_id = k.item_id), 0))::text as quantity,
            (w.total_value + coalesce((select sum(remaining_value) from val_layers l
                                        where l.store_id = k.store_id and l.item_id = k.item_id), 0))::text as value
       from val_keys k
       join val_wa_state w on w.store_id = k.store_id and w.item_id = k.item_id
      where ($1::uuid is null or k.store_id = $1) and ($2::uuid is null or k.item_id = $2)
      order by k.store_id, k.item_id`,
    [filter.storeId ?? null, filter.itemId ?? null],
  );
