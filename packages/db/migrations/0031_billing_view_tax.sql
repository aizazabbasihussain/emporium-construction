-- P2-08: profitability reports collected money as gross and base, so receivables needs the tax of
-- each issued invoice. A column is appended to the published view; nothing else changes.
create or replace view bil_v_invoices with (security_invoker = true) as
select i.id, i.number, i.series_code, i.authority_code, i.source_type, i.project_id, i.party_id,
       i.invoice_date, i.due_date, i.status, i.gross_total, i.withholding_expected,
       coalesce((select sum(c.gross_total) from bil_credit_notes c
                  where c.invoice_id = i.id and c.status = 'issued'), 0)::numeric(18,2) as credited_total,
       i.tax_total
  from bil_invoices i
 where i.deleted_at is null;
