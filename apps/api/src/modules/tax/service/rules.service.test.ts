import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  auditCount,
  createTaxKit,
  eventCount,
  FROM,
  MANAGEMENT,
  TEST_SALES,
  type TaxKit,
} from '../test-support.js';

let kit: TaxKit;
beforeAll(async () => {
  kit = await createTaxKit();
}, 60_000);
afterAll(() => kit.close());

const listSales = (status?: 'pending_approval' | 'active' | 'rejected') =>
  kit.tax.rules.listSalesRules(kit.db, status);

describe('rule requests (BR-2, BR-5, BR-6)', () => {
  it('ships with no rules at all (BR-9) but the two authorities and the H-08 default', async () => {
    const fresh = await createTaxKit();
    try {
      expect(await fresh.tax.rules.listSalesRules(fresh.db)).toEqual([]);
      expect(await fresh.tax.rules.listWithholdingRules(fresh.db)).toEqual([]);
      expect(await fresh.tax.rules.listRegionMap(fresh.db)).toEqual([]);
      expect((await fresh.tax.rules.authorities(fresh.db)).map((a) => a.code)).toEqual([
        'FBR',
        'PRA',
      ]);
      expect(await fresh.tax.rules.settings(fresh.db)).toEqual({
        roundingMode: 'per_document',
        pricesIncludeTax: false,
      });
    } finally {
      await fresh.close();
    }
  });

  it('records a pending rule, asks the owner and audits the request', async () => {
    const before = await auditCount(kit.db, 'tax.rule.request');
    const events = await eventCount(kit.db, 'tax.rule.changed');
    const id = await kit.requestSales({ ...TEST_SALES, nature: 'request-demo', taxCode: 'T1' });
    const [rule] = await listSales('pending_approval');
    expect(rule).toMatchObject({
      id,
      status: 'pending_approval',
      ratePercent: '10.0000',
      nature: 'request-demo',
      requestedBy: ACCOUNTANT,
      approvedBy: null,
      effectiveTo: null,
      note: null,
    });
    expect((await kit.approvals.getApprovalState(kit.db, 'tax_rule', id)).status).toBe('pending');
    expect(await auditCount(kit.db, 'tax.rule.request')).toBe(before + 1);
    expect(await eventCount(kit.db, 'tax.rule.changed')).toBe(events + 1);
  });

  it('activates the rule on approval and audits the activation', async () => {
    const before = await auditCount(kit.db, 'tax.rule.activate');
    const id = await kit.approveSales({ ...TEST_SALES, nature: 'activate-demo' });
    const active = (await listSales('active')).find((rule) => rule.id === id);
    expect(active).toMatchObject({ status: 'active', approvedBy: MANAGEMENT });
    expect(await auditCount(kit.db, 'tax.rule.activate')).toBe(before + 1);
  });

  it('rejects the rule when the owner rejects it, and ignores a repeated event', async () => {
    const id = await kit.requestSales({ ...TEST_SALES, nature: 'reject-demo' });
    await kit.decide(id, 'reject');
    expect((await listSales('rejected')).map((rule) => rule.id)).toContain(id);
    const audits = await auditCount(kit.db, 'tax.rule.reject');
    // A second delivery of the same outcome changes nothing.
    await kit.tx((tx) =>
      kit.tax.rules.onApprovalOutcome('rejected', { docId: id, requesterId: ACCOUNTANT }, tx),
    );
    expect(await auditCount(kit.db, 'tax.rule.reject')).toBe(audits);
  });

  it('ignores approvals of other document types', async () => {
    const id = await kit.requestSales({ ...TEST_SALES, nature: 'other-type' });
    await kit.tx((tx) =>
      kit.platform.events.publish(
        {
          type: 'approval.approved',
          payload: { docType: 'something_else', docId: id, requesterId: ACCOUNTANT },
        },
        tx,
      ),
    );
    await kit.platform.events.dispatchDue(kit.db);
    expect((await listSales('pending_approval')).map((rule) => rule.id)).toContain(id);
  });

  it('ignores an outcome for an unknown document', async () => {
    await kit.tx((tx) =>
      kit.tax.rules.onApprovalOutcome(
        'approved',
        { docId: '018f0000-0000-7000-8000-00000000dead', requesterId: ACCOUNTANT },
        tx,
      ),
    );
  });

  it('falls back to the requester when no approver is recorded', async () => {
    const id = await kit.requestSales({ ...TEST_SALES, nature: 'cancel-demo' });
    await kit.tx((tx) =>
      kit.tax.rules.onApprovalOutcome('cancelled', { docId: id, requesterId: ACCOUNTANT }, tx),
    );
    const rejected = (await listSales('rejected')).find((rule) => rule.id === id);
    expect(rejected).toMatchObject({ status: 'rejected', approvedBy: null });
  });

  it('closes an open-ended predecessor the day before the successor starts (BR-5)', async () => {
    const first = await kit.approveSales({
      ...TEST_SALES,
      nature: 'succession',
      effectiveFrom: '2026-01-01',
    });
    const second = await kit.approveSales({
      ...TEST_SALES,
      nature: 'succession',
      ratePercent: '12',
      effectiveFrom: '2026-07-01',
    });
    const rules = await listSales('active');
    expect(rules.find((rule) => rule.id === first)).toMatchObject({ effectiveTo: '2026-06-30' });
    expect(rules.find((rule) => rule.id === second)).toMatchObject({ effectiveTo: null });
  });

  it('rejects overlapping ranges when requested (BR-2)', async () => {
    await kit.approveSales({ ...TEST_SALES, nature: 'overlap', effectiveFrom: '2026-01-01' });
    await expect(
      kit.requestSales({ ...TEST_SALES, nature: 'overlap', effectiveFrom: '2026-01-01' }),
    ).rejects.toMatchObject({ code: 'tax_rule_overlap' });
    await expect(
      kit.requestSales({
        ...TEST_SALES,
        nature: 'overlap',
        effectiveFrom: '2026-03-01',
        effectiveTo: '2026-04-01',
      }),
    ).rejects.toMatchObject({ code: 'tax_rule_overlap' });
  });

  it('rejects at approval a request whose dates were taken after it was made', async () => {
    const input = { ...TEST_SALES, nature: 'race', effectiveFrom: '2026-02-01' };
    const a = await kit.requestSales(input);
    const b = await kit.requestSales({ ...input, ratePercent: '11' });
    await kit.decide(a, 'approve');
    await kit.decide(b, 'approve');
    const all = await listSales();
    expect(all.find((rule) => rule.id === a)?.status).toBe('active');
    expect(all.find((rule) => rule.id === b)?.status).toBe('rejected');
  });

  it('checks the authority, the dates and the rate', async () => {
    await expect(kit.requestSales({ ...TEST_SALES, authorityCode: 'NOPE' })).rejects.toMatchObject({
      code: 'tax_authority_unknown',
    });
    await expect(
      kit.requestSales({ ...TEST_SALES, effectiveFrom: '2026-02-30' }),
    ).rejects.toMatchObject({ code: 'invalid_date' });
    await expect(
      kit.requestSales({ ...TEST_SALES, effectiveFrom: '2026-05-02', effectiveTo: '2026-05-01' }),
    ).rejects.toMatchObject({ code: 'tax_range_invalid' });
    await expect(
      kit.requestSales({ ...TEST_SALES, ratePercent: '100.0001' }),
    ).rejects.toMatchObject({ code: 'tax_rate_out_of_range' });
    await expect(kit.requestSales({ ...TEST_SALES, ratePercent: '-1' })).rejects.toMatchObject({
      code: 'tax_rate_out_of_range',
    });
    await expect(kit.requestSales({ ...TEST_SALES, ratePercent: '1.23456' })).rejects.toMatchObject(
      { code: 'percent_precision' },
    );
  });

  it('allows a zero rate and a closed range', async () => {
    const id = await kit.approveSales({
      ...TEST_SALES,
      nature: 'zero',
      ratePercent: '0',
      effectiveFrom: FROM,
      effectiveTo: '2026-12-31',
      note: 'exempt',
    });
    expect((await listSales('active')).find((rule) => rule.id === id)).toMatchObject({
      ratePercent: '0.0000',
      effectiveTo: '2026-12-31',
      note: 'exempt',
    });
  });
});

describe('withholding rules and the region map', () => {
  const withholding = {
    direction: 'we_withhold',
    authorityCode: 'FBR',
    nature: 'civil',
    ratePercent: '2',
    base: 'on_base',
    effectiveFrom: FROM,
  } as const;

  it('requests, approves and succeeds a withholding rule', async () => {
    const first = await kit.approveWithholding({ ...withholding, partyType: 'vendor' });
    const second = await kit.approveWithholding({
      ...withholding,
      partyType: 'vendor',
      ratePercent: '3',
      effectiveFrom: '2026-09-01',
    });
    const rules = await kit.tax.rules.listWithholdingRules(kit.db, 'active');
    expect(rules.find((rule) => rule.id === first)).toMatchObject({
      effectiveTo: '2026-08-31',
      partyType: 'vendor',
      base: 'on_base',
    });
    expect(rules.find((rule) => rule.id === second)).toMatchObject({ ratePercent: '3.0000' });
  });

  it('keeps withholding rules for different parties apart and defaults the party to any', async () => {
    const any = await kit.approveWithholding({ ...withholding, nature: 'parties' });
    const other = await kit.approveWithholding({
      ...withholding,
      nature: 'parties',
      partyType: 'subcontractor',
    });
    const rules = await kit.tax.rules.listWithholdingRules(kit.db, 'active');
    expect(rules.find((rule) => rule.id === any)).toMatchObject({
      partyType: null,
      effectiveTo: null,
    });
    expect(rules.find((rule) => rule.id === other)).toMatchObject({ effectiveTo: null });
  });

  it('requests and approves a region mapping, then rejects an overlapping one', async () => {
    const id = await kit.approveRegion({
      region: 'islamabad',
      supplyKind: 'goods',
      authorityCode: 'FBR',
      effectiveFrom: FROM,
    });
    expect((await kit.tax.rules.listRegionMap(kit.db, 'active')).map((r) => r.id)).toContain(id);
    await expect(
      kit.requestRegion({
        region: 'islamabad',
        supplyKind: 'goods',
        authorityCode: 'PRA',
        effectiveFrom: FROM,
      }),
    ).rejects.toMatchObject({ code: 'tax_rule_overlap' });
  });
});

describe('settings', () => {
  it('reads the rounding mode and price basis from tax_settings', async () => {
    await kit.db.query("update tax_settings set value = 'per_line' where key = 'rounding_mode'");
    await kit.db.query("update tax_settings set value = 'true' where key = 'prices_include_tax'");
    expect(await kit.tax.rules.settings(kit.db)).toEqual({
      roundingMode: 'per_line',
      pricesIncludeTax: true,
    });
    await kit.db.query(
      "update tax_settings set value = 'per_document' where key = 'rounding_mode'",
    );
    await kit.db.query("update tax_settings set value = 'false' where key = 'prices_include_tax'");
  });
});
