import type { SqlDb } from '@emporium/db';

/** One failed check of BR-6; `detail` names the key so a human can find the rows. */
export interface IntegrityFinding {
  check: IntegrityCheck;
  detail: string;
}

export const integrityChecks = [
  'negative_balance',
  'balance_ledger_mismatch',
  'valuation_value_drift',
  'cost_summary_mismatch',
  'outbox_pending',
  'outbox_failed',
] as const;
export type IntegrityCheck = (typeof integrityChecks)[number];

interface Row {
  detail: string;
}

const KEY = `store_id::text || '/' || item_id::text`;

/** Inventory balances must never be negative (BR-6). */
const NEGATIVE_BALANCE = `
  select ${KEY} || ' quantity ' || quantity::text as detail
    from inv_balances where quantity < 0`;

/** The balance of each key equals the sum of its append-only ledger (BR-6). */
const BALANCE_LEDGER = `
  with ledger as (
    select store_id, item_id, ownership, owner_party_id, sum(quantity) as qty
      from inv_ledger group by store_id, item_id, ownership, owner_party_id
  )
  select coalesce(b.store_id, l.store_id)::text || '/' || coalesce(b.item_id, l.item_id)::text
         || ' balance ' || coalesce(b.quantity, 0)::text || ' ledger ' || coalesce(l.qty, 0)::text as detail
    from inv_balances b
    full join ledger l
      on l.store_id = b.store_id and l.item_id = b.item_id and l.ownership = b.ownership
     and l.owner_party_id is not distinct from b.owner_party_id
   where coalesce(b.quantity, 0) <> coalesce(l.qty, 0)`;

/**
 * Valuation conservation (BR-6): for each key, value received minus value issued, adjusted by the
 * value change of any method switch, equals the stock value held in the weighted average state and
 * the FIFO layers.
 */
const VALUATION_DRIFT = `
  with moved as (
    select store_id, item_id,
           sum(case when type in ('receipt', 'transfer_in', 'return') then value
                    when type in ('issue', 'transfer_out') then -value
                    else 0 end) as net
      from val_movements group by store_id, item_id
  ), switched as (
    select store_id, item_id, sum(value_after - value_before) as delta
      from val_transitions group by store_id, item_id
  ), held_wa as (
    select store_id, item_id, sum(total_value) as value from val_wa_state group by store_id, item_id
  ), held_layers as (
    select store_id, item_id, sum(remaining_value) as value from val_layers group by store_id, item_id
  ), keys as (
    select store_id, item_id from moved
    union select store_id, item_id from held_wa
    union select store_id, item_id from held_layers
  )
  select k.store_id::text || '/' || k.item_id::text
         || ' expected ' || (coalesce(m.net, 0) + coalesce(s.delta, 0))::text
         || ' held ' || (coalesce(w.value, 0) + coalesce(l.value, 0))::text as detail
    from keys k
    left join moved m using (store_id, item_id)
    left join switched s using (store_id, item_id)
    left join held_wa w using (store_id, item_id)
    left join held_layers l using (store_id, item_id)
   where coalesce(m.net, 0) + coalesce(s.delta, 0) <> coalesce(w.value, 0) + coalesce(l.value, 0)`;

/** The project cost summary equals the latest entry of every chain, grouped again from the source rows (BR-6). */
const COST_SUMMARY = `
  with latest as (
    select cost_object_type, cost_object_id, cost_code_id, amount, status,
           row_number() over (partition by chain_key order by seq desc) as rn
      from prj_cost_entries
  ), expected as (
    select cost_object_type, cost_object_id, cost_code_id,
           coalesce(sum(amount) filter (where status = 'committed'), 0) as committed,
           coalesce(sum(amount) filter (where status = 'approved'), 0) as approved,
           coalesce(sum(amount) filter (where status = 'posted'), 0) as posted
      from latest where rn = 1 and status <> 'reversed'
     group by cost_object_type, cost_object_id, cost_code_id
  )
  select coalesce(e.cost_object_type, v.cost_object_type) || '/' || coalesce(e.cost_object_id, v.cost_object_id)::text
         || '/' || coalesce(e.cost_code_id, v.cost_code_id)::text
         || ' source ' || coalesce(e.committed, 0)::text || '|' || coalesce(e.approved, 0)::text || '|' || coalesce(e.posted, 0)::text
         || ' summary ' || coalesce(v.committed, 0)::text || '|' || coalesce(v.approved, 0)::text || '|' || coalesce(v.posted, 0)::text as detail
    from expected e
    full join prj_v_cost_summary v
      on v.cost_object_type = e.cost_object_type and v.cost_object_id is not distinct from e.cost_object_id
     and v.cost_code_id = e.cost_code_id
   where coalesce(e.committed, 0) <> coalesce(v.committed, 0)
      or coalesce(e.approved, 0) <> coalesce(v.approved, 0)
      or coalesce(e.posted, 0) <> coalesce(v.posted, 0)`;

/** Events that were never delivered (no orphan outbox events) or gave up (no failed events). */
const OUTBOX_PENDING = `
  select id::text || ' ' || type as detail from sys_outbox
   where dispatched_at is null and failed_at is null`;
const OUTBOX_FAILED = `
  select id::text || ' ' || type || ' ' || coalesce(last_error, '') as detail
    from sys_outbox where failed_at is not null`;

const QUERIES: Record<IntegrityCheck, string> = {
  negative_balance: NEGATIVE_BALANCE,
  balance_ledger_mismatch: BALANCE_LEDGER,
  valuation_value_drift: VALUATION_DRIFT,
  cost_summary_mismatch: COST_SUMMARY,
  outbox_pending: OUTBOX_PENDING,
  outbox_failed: OUTBOX_FAILED,
};

/** Runs the integrity checks of P1-21 BR-6 and returns every violation found (empty means healthy). */
export async function runIntegrityChecks(db: SqlDb): Promise<IntegrityFinding[]> {
  const findings: IntegrityFinding[] = [];
  for (const check of integrityChecks) {
    for (const row of await db.query<Row>(QUERIES[check])) {
      findings.push({ check, detail: row.detail });
    }
  }
  return findings;
}
