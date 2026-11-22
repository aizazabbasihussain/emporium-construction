import type { SqlDb } from '@emporium/db';

/**
 * The finance reconciliations of P2-10 BR-3 that can be recomputed from the database alone. Each
 * check derives a figure twice, from two places that must agree, and reports every key where they
 * do not. An empty result means the books reconcile to the paisa.
 *
 * The three reconciliations that need a module's own output (profitability against the worksheet,
 * export control totals and the customer ledger balance as the API reports it) are asserted in the
 * Gate B scenario, where the API is called.
 */
export const reconciliationChecks = [
  'customer_ledger',
  'vendor_ledger',
  'cash_book',
  'bank_reconciliation',
  'stock_valuation',
  'cost_ledger',
  'tax_report',
  'payroll_cash',
] as const;
export type ReconciliationCheck = (typeof reconciliationChecks)[number];

/** One failed reconciliation; `detail` names the document or key so a human can find it. */
export interface ReconciliationFinding {
  check: ReconciliationCheck;
  detail: string;
}

interface Row {
  detail: string;
}

/**
 * Customer ledger = open invoices - allocated receipts (BR-3). Allocations must fit inside their
 * receipt (amount plus tax withheld), inside the invoice they settle, and an invoice's gross must
 * equal its taxable base plus tax less the advance it recovers.
 */
const CUSTOMER_LEDGER = `
  with valid_receipts as (
    select * from rcv_receipts where status not in ('bounced', 'cancelled')
  ), valid_allocations as (
    select a.* from rcv_allocations a join valid_receipts r on r.id = a.receipt_id
  ), receipt_totals as (
    select receipt_id, sum(amount) as allocated,
           coalesce(sum(amount) filter (where kind = 'withholding'), 0) as withheld
      from rcv_allocations group by receipt_id
  ), invoice_totals as (
    select invoice_id, sum(amount) as allocated from valid_allocations group by invoice_id
  ), adjustment_totals as (
    select invoice_id, sum(amount) as adjusted from rcv_adjustments group by invoice_id
  )
  select 'receipt ' || r.number || ' allocates ' || t.allocated::text
         || ' of ' || (r.amount + r.withheld_amount)::text as detail
    from rcv_receipts r join receipt_totals t on t.receipt_id = r.id
   where t.allocated > r.amount + r.withheld_amount
  union all
  select 'receipt ' || r.number || ' withholding allocated ' || t.withheld::text
         || ' withheld ' || r.withheld_amount::text
    from rcv_receipts r join receipt_totals t on t.receipt_id = r.id
   where t.withheld <> r.withheld_amount
  union all
  select 'invoice ' || i.number || ' outstanding '
         || (i.gross_total - i.credited_total - coalesce(t.allocated, 0) - coalesce(j.adjusted, 0))::text
    from bil_v_invoices i
    left join invoice_totals t on t.invoice_id = i.id
    left join adjustment_totals j on j.invoice_id = i.id
   where i.status = 'issued'
     and i.gross_total - i.credited_total - coalesce(t.allocated, 0) - coalesce(j.adjusted, 0) < 0
  union all
  select 'invoice ' || number || ' gross ' || gross_total::text || ' expected '
         || (taxable_base + tax_total - advance_recovery)::text
    from bil_invoices
   where status = 'issued' and gross_total <> taxable_base + tax_total - advance_recovery`;

/**
 * Vendor ledger = posted bills - payments (BR-3): the ledger view reads the payment headers, the
 * allocations that settle bills are the second source. Bill headers must add up.
 */
const VENDOR_LEDGER = `
  with view_totals as (
    select vendor_party_id, sum(credit) - sum(debit) as net from pay_v_vendor_ledger group by vendor_party_id
  ), bill_totals as (
    select vendor_party_id, sum(gross_total) as billed from pay_bills
     where status in ('posted', 'partly_paid', 'paid') group by vendor_party_id
  ), payment_totals as (
    select p.vendor_party_id, sum(a.amount) as paid
      from pay_payment_allocations a join pay_payments p on p.id = a.payment_id
     where p.status = 'paid' group by p.vendor_party_id
  ), vendors as (
    select vendor_party_id from view_totals union select vendor_party_id from bill_totals
  )
  select v.vendor_party_id::text || ' ledger ' || coalesce(l.net, 0)::text
         || ' bills less payments ' || (coalesce(b.billed, 0) - coalesce(p.paid, 0))::text
    from vendors v
    left join view_totals l on l.vendor_party_id = v.vendor_party_id
    left join bill_totals b on b.vendor_party_id = v.vendor_party_id
    left join payment_totals p on p.vendor_party_id = v.vendor_party_id
   where coalesce(l.net, 0) <> coalesce(b.billed, 0) - coalesce(p.paid, 0)
  union all
  select 'bill ' || number || ' gross ' || gross_total::text || ' base + tax ' || (base_amount + tax_total)::text
    from pay_bills where status <> 'cancelled' and gross_total <> base_amount + tax_total
  union all
  select 'bill ' || number || ' net ' || net_payable::text || ' gross - withholding '
         || (gross_total - withholding_total)::text
    from pay_bills where status <> 'cancelled' and net_payable <> gross_total - withholding_total
  union all
  select 'bill ' || b.number || ' base ' || b.base_amount::text || ' lines ' || l.total::text
    from pay_bills b
    join (select bill_id, sum(amount) as total from pay_bill_lines group by bill_id) l on l.bill_id = b.id
   where b.status <> 'cancelled' and b.source_type <> 'opening' and b.base_amount <> l.total
  union all
  select 'payment ' || p.number || ' pays ' || (p.amount + p.withholding_deducted)::text
         || ' allocated ' || coalesce(a.total, 0)::text
    from pay_payments p
    left join (select payment_id, sum(amount) as total from pay_payment_allocations group by payment_id) a
      on a.payment_id = p.id
   where p.status = 'paid' and p.amount + p.withholding_deducted <> coalesce(a.total, 0)`;

/**
 * Cash book balance per account = opening + movements (BR-3), and every cleared receipt and paid
 * payment is in the cash book once, for its own amount, in the right direction. Transfers net to
 * zero.
 */
const CASH_BOOK = `
  with raw as (
    select a.id, a.code, a.opening_balance
             + coalesce(sum(case t.direction when 'in' then t.amount else -t.amount end), 0) as balance
      from cbk_accounts a left join cbk_transactions t on t.account_id = a.id
     group by a.id, a.code, a.opening_balance
  ), viewed as (
    select a.id, a.opening_balance + coalesce(sum(v.signed_amount), 0) as balance
      from cbk_accounts a left join cbk_v_transactions v on v.account_id = a.id
     group by a.id, a.opening_balance
  )
  select 'account ' || raw.code || ' movements ' || raw.balance::text || ' book ' || viewed.balance::text
    from raw join viewed using (id) where raw.balance <> viewed.balance
  union all
  select 'receipt ' || r.number || ' amount ' || r.amount::text || ' cash book ' || t.amount::text
    from rcv_receipts r join cbk_transactions t on t.id = r.cashbook_txn_id
   where r.amount <> t.amount or t.direction <> 'in' or r.account_id <> t.account_id
  union all
  select 'receipt ' || number || ' is cleared without a cash book entry'
    from rcv_receipts where status = 'cleared' and cashbook_txn_id is null
  union all
  select 'payment ' || p.number || ' amount ' || p.amount::text || ' cash book ' || t.amount::text
    from pay_payments p join cbk_transactions t on t.id = p.cashbook_txn_id
   where p.amount <> t.amount or t.direction <> 'out' or p.account_id <> t.account_id
  union all
  select 'payment ' || number || ' is paid without a cash book entry'
    from pay_payments where status = 'paid' and cashbook_txn_id is null
  union all
  select 'transfer ' || transfer_pair_id::text || ' nets ' || sum(case direction when 'in' then amount else -amount end)::text
    from cbk_transactions where transfer_pair_id is not null
   group by transfer_pair_id
  having sum(case direction when 'in' then amount else -amount end) <> 0
  union all
  select 'entry ' || t.number || ' is dated before the opening of its account'
    from cbk_transactions t join cbk_accounts a on a.id = t.account_id where t.txn_date < a.opening_date`;

/**
 * Every completed bank reconciliation has a zero difference that holds when recomputed from the
 * book and the statement lines (statement closing = book - unreconciled book + unreconciled lines).
 */
const BANK_RECONCILIATION = `
  with recs as (
    select * from cbk_reconciliations where status = 'completed'
  ), book as (
    select r.id as rec_id,
           a.opening_balance + coalesce(sum(case t.direction when 'in' then t.amount else -t.amount end), 0) as balance
      from recs r join cbk_accounts a on a.id = r.account_id
      left join cbk_transactions t on t.account_id = r.account_id and t.txn_date <= r.statement_to
     group by r.id, a.opening_balance
  ), open_book as (
    select r.id as rec_id,
           coalesce(sum(case t.direction when 'in' then t.amount else -t.amount end), 0) as amount
      from recs r
      left join cbk_transactions t
        on t.account_id = r.account_id and t.txn_date <= r.statement_to
       and not exists (
         select 1 from cbk_reconciliation_items i
           join cbk_reconciliations r2 on r2.id = i.reconciliation_id
          where i.transaction_id = t.id and r2.account_id = r.account_id
            and r2.status = 'completed' and r2.statement_to <= r.statement_to)
     group by r.id
  ), open_lines as (
    select r.id as rec_id, coalesce(sum(l.credit - l.debit), 0) as amount
      from recs r left join cbk_statement_lines l
        on l.reconciliation_id = r.id and l.matched_transaction_id is null
     group by r.id
  )
  select 'reconciliation of ' || r.statement_to::text || ' recomputed difference '
         || (r.statement_closing_balance - (b.balance - ob.amount + ol.amount))::text
    from recs r
    join book b on b.rec_id = r.id
    join open_book ob on ob.rec_id = r.id
    join open_lines ol on ol.rec_id = r.id
   where r.statement_closing_balance - (b.balance - ob.amount + ol.amount) <> 0
  union all
  select 'reconciliation of ' || r.statement_to::text || ' stored difference ' || coalesce(r.difference::text, 'none')
    from recs r where r.difference is distinct from 0
  union all
  select 'reconciliation of ' || r.statement_to::text || ' stored book balance ' || coalesce(r.book_balance_at_end::text, 'none')
         || ' recomputed ' || b.balance::text
    from recs r join book b on b.rec_id = r.id where r.book_balance_at_end is distinct from b.balance`;

/**
 * The valuation engine total equals the company stock at valuation cost, item by item and store by
 * store: the signed value of the ledger against the weighted average state and the FIFO layers.
 */
const STOCK_VALUATION = `
  with ledger as (
    select store_id, item_id,
           sum(case when quantity > 0 then abs(coalesce(value, 0)) else -abs(coalesce(value, 0)) end) as value
      from inv_ledger where ownership = 'company' group by store_id, item_id
  ), held_wa as (
    select store_id, item_id, sum(total_value) as value from val_wa_state group by store_id, item_id
  ), held_layers as (
    select store_id, item_id, sum(remaining_value) as value from val_layers group by store_id, item_id
  ), keys as (
    select store_id, item_id from ledger union select store_id, item_id from held_wa
    union select store_id, item_id from held_layers
  )
  select k.store_id::text || '/' || k.item_id::text || ' ledger value ' || coalesce(l.value, 0)::text
         || ' valuation ' || (coalesce(w.value, 0) + coalesce(y.value, 0))::text
    from keys k
    left join ledger l using (store_id, item_id)
    left join held_wa w using (store_id, item_id)
    left join held_layers y using (store_id, item_id)
   where coalesce(l.value, 0) <> coalesce(w.value, 0) + coalesce(y.value, 0)`;

/**
 * Posted cost per cost object equals the source documents behind it: stock issues, finalized
 * payroll, certified subcontract work with its back-charges, vendor price variances and posted
 * expense claims.
 */
const COST_LEDGER = `
  with latest as (
    select cost_object_type, cost_object_id, amount, status, source_module, source_doc_type,
           row_number() over (partition by chain_key order by seq desc) as rn
      from prj_cost_entries
  ), ledger as (
    select cost_object_type || '/' || coalesce(cost_object_id::text, '-') as key, sum(amount) as posted
      from latest where rn = 1 and status = 'posted' group by 1
  ), sources as (
    select cost_object_type || '/' || coalesce(cost_object_id::text, '-') as key,
           case movement_type when 'issue' then value else -value end as amount
      from inv_ledger
     where cost_object_type in ('project', 'overhead') and ownership = 'company'
       and movement_type in ('issue', 'return_in')
    union all
    select 'project/' || e.project_id::text, e.amount
      from pyr_cost_entries e join pyr_runs r on r.id = e.run_id
     where e.revision = (select max(x.revision) from pyr_cost_entries x where x.run_id = e.run_id)
       and r.status in ('finalized', 'paid', 'partly_paid')
    union all
    select 'project/' || w.project_id::text, c.this_certificate_amount
      from sub_certificates c
      join sub_work_orders w on w.id = c.work_order_id
      join pay_bills b on b.id = c.bill_id
     where b.posted_on is not null and b.cancelled_on is null
    union all
    select 'project/' || w.project_id::text, -k.amount
      from sub_back_charges k
      join sub_certificates c on c.id = k.certificate_id
      join sub_work_orders w on w.id = c.work_order_id
      join pay_bills b on b.id = c.bill_id
     where k.recovers_cost and k.deleted_at is null and b.posted_on is not null and b.cancelled_on is null
    union all
    select v.cost_object_type || '/' || coalesce(v.cost_object_id::text, '-'), v.amount
      from pay_variances v where v.reversed_on is null
    union all
    select l.cost_object_type || '/' || coalesce(l.cost_object_id::text, '-'), l.amount
      from exp_claim_lines l join exp_claims c on c.id = l.claim_id where c.status = 'posted'
  ), source_totals as (
    select key, sum(amount) as total from sources group by key
  ), keys as (
    select key from ledger union select key from source_totals
  )
  select k.key || ' ledger ' || coalesce(l.posted, 0)::text || ' source documents ' || coalesce(s.total, 0)::text
    from keys k
    left join ledger l on l.key = k.key
    left join source_totals s on s.key = k.key
   where coalesce(l.posted, 0) <> coalesce(s.total, 0)`;

/**
 * Tax report totals = the sum of the tax snapshots of invoices, credit notes and bills: the stored
 * header figure must equal the figure in the snapshot taken when the document was issued or posted.
 */
const TAX_REPORT = `
  select 'invoice ' || number || ' tax ' || tax_total::text || ' snapshot ' || (tax_snapshot ->> 'taxTotal')
    from bil_invoices
   where status = 'issued' and tax_snapshot is not null
     and tax_total <> (tax_snapshot ->> 'taxTotal')::numeric
  union all
  select 'credit note ' || number || ' tax ' || tax_total::text || ' snapshot ' || (tax_snapshot ->> 'taxTotal')
    from bil_credit_notes
   where status = 'issued' and tax_snapshot is not null
     and tax_total <> (tax_snapshot ->> 'taxTotal')::numeric
  union all
  select 'bill ' || number || ' tax ' || tax_total::text || ' snapshot ' || (tax_snapshot -> 'sales' ->> 'taxTotal')
    from pay_bills
   where status in ('posted', 'partly_paid', 'paid') and tax_snapshot is not null
     and tax_total <> (tax_snapshot -> 'sales' ->> 'taxTotal')::numeric
  union all
  select 'invoice ' || number || ' has no tax snapshot'
    from bil_invoices where status = 'issued' and tax_snapshot is null and source_type <> 'advance'
  union all
  select 'invoice ' || number || ' snapshot lines add up to ' || s.total::text || ' of ' || i.tax_total::text
    from bil_invoices i
    cross join lateral (
      select coalesce(sum((g ->> 'tax')::numeric), 0) as total
        from jsonb_array_elements(i.tax_snapshot -> 'taxLines') g) s
   where i.status = 'issued' and i.tax_snapshot is not null and s.total <> i.tax_total`;

/** Payroll total paid = the payroll payments in the cash book (BR-3). */
const PAYROLL_CASH = `
  with paid as (
    select run_id, sum(amount) as total from pyr_payments where status = 'paid' group by run_id
  ), lines as (
    select run_id, sum(net_pay) as total from pyr_lines
     where payment_status = 'paid' and deleted_at is null group by run_id
  ), cash as (
    select l.run_id, sum(t.amount) as total
      from (select distinct run_id, cashbook_txn_id from pyr_lines
             where payment_status = 'paid' and cashbook_txn_id is not null) l
      join cbk_transactions t on t.id = l.cashbook_txn_id
     group by l.run_id
  )
  select 'run ' || r.year::text || '-' || r.month::text || ' payments ' || coalesce(p.total, 0)::text
         || ' lines ' || coalesce(l.total, 0)::text || ' cash book ' || coalesce(c.total, 0)::text
         || ' recorded ' || r.total_paid::text
    from pyr_runs r
    left join paid p on p.run_id = r.id
    left join lines l on l.run_id = r.id
    left join cash c on c.run_id = r.id
   where coalesce(p.total, 0) <> coalesce(c.total, 0)
      or coalesce(p.total, 0) <> coalesce(l.total, 0)
      or coalesce(p.total, 0) <> r.total_paid`;

const QUERIES: Record<ReconciliationCheck, string> = {
  customer_ledger: CUSTOMER_LEDGER,
  vendor_ledger: VENDOR_LEDGER,
  cash_book: CASH_BOOK,
  bank_reconciliation: BANK_RECONCILIATION,
  stock_valuation: STOCK_VALUATION,
  cost_ledger: COST_LEDGER,
  tax_report: TAX_REPORT,
  payroll_cash: PAYROLL_CASH,
};

/** Runs one reconciliation and returns every key where the two figures differ. */
export async function runReconciliation(
  db: SqlDb,
  check: ReconciliationCheck,
): Promise<ReconciliationFinding[]> {
  const rows = await db.query<Row>(`select detail from (${QUERIES[check]}) as r(detail)`);
  return rows.map((row) => ({ check, detail: row.detail }));
}

/** Runs every reconciliation of BR-3 (empty means every figure holds to the paisa). */
export async function runReconciliations(db: SqlDb): Promise<ReconciliationFinding[]> {
  const findings: ReconciliationFinding[] = [];
  for (const check of reconciliationChecks) findings.push(...(await runReconciliation(db, check)));
  return findings;
}
