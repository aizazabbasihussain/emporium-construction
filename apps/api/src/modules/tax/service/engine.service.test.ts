import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FROM, TEST_SALES, createTaxKit, uid, type TaxKit } from '../test-support.js';

let kit: TaxKit;
beforeAll(async () => {
  kit = await createTaxKit();
}, 60_000);
afterAll(() => kit.close());

const DATE = '2026-06-15';
const lines = [{ id: 'l1', amount: '1000.00' }];

/** Synthetic test setup: Islamabad services are taxed by FBR, Punjab services by PRA. */
async function mapRegions() {
  for (const supplyKind of ['services', 'goods'] as const) {
    await kit.approveRegion({
      region: 'islamabad',
      supplyKind,
      authorityCode: 'FBR',
      effectiveFrom: FROM,
    });
  }
  await kit.approveRegion({
    region: 'punjab',
    supplyKind: 'services',
    authorityCode: 'PRA',
    effectiveFrom: FROM,
  });
}

describe('refusal without rules (T-6, BR-9)', () => {
  it('blocks when no authority is mapped, naming what is missing', async () => {
    await expect(
      kit.tax.resolveAuthority(kit.db, {
        locationId: kit.islamabadId,
        supplyKind: 'services',
        date: DATE,
      }),
    ).rejects.toMatchObject({
      code: 'tax_authority_unmapped',
      message: 'No tax authority is mapped for services in islamabad on 2026-06-15',
    });
    await expect(
      kit.tax.calculateSalesTax(kit.db, {
        locationId: kit.islamabadId,
        supplyKind: 'services',
        date: DATE,
        lines,
      }),
    ).rejects.toMatchObject({ code: 'tax_authority_unmapped' });
  });

  it('blocks when the location is unknown', async () => {
    await expect(
      kit.tax.resolveAuthority(kit.db, {
        locationId: uid(9999),
        supplyKind: 'services',
        date: DATE,
      }),
    ).rejects.toMatchObject({ code: 'location_not_found' });
  });

  it('blocks when the company has no registration with the mapped authority', async () => {
    await mapRegions();
    await expect(
      kit.tax.resolveAuthority(kit.db, {
        locationId: kit.lahoreId,
        supplyKind: 'services',
        date: DATE,
      }),
    ).rejects.toMatchObject({
      code: 'tax_registration_missing',
      message: 'The company has no PRA registration on 2026-06-15',
    });
  });

  it('blocks when the authority has no rule, naming it', async () => {
    await expect(
      kit.tax.calculateSalesTax(kit.db, {
        locationId: kit.islamabadId,
        supplyKind: 'services',
        date: DATE,
        lines,
      }),
    ).rejects.toMatchObject({
      code: 'tax_rule_missing',
      message: 'No active sales tax rule for FBR services on 2026-06-15',
    });
  });
});

describe('resolution and calculation (AC-1, T-1, T-3, T-6)', () => {
  beforeAll(async () => {
    await kit.tx((tx) =>
      kit.masterData.company.createRegistration(
        {
          authority: 'PRA',
          registrationType: 'pra',
          number: 'TEST-PRA-0001',
          validFrom: '2020-01-01',
        },
        kit.actor,
        tx,
      ),
    );
    await kit.approveSales({
      ...TEST_SALES,
      authorityCode: 'FBR',
      ratePercent: '10',
      taxCode: 'FBR-ST',
    });
    await kit.approveSales({
      ...TEST_SALES,
      authorityCode: 'PRA',
      ratePercent: '5',
      taxCode: 'PRA-ST',
    });
    await kit.approveSales({
      ...TEST_SALES,
      authorityCode: 'FBR',
      nature: 'civil',
      ratePercent: '8',
      taxCode: 'FBR-CIVIL',
    });
  });

  it('resolves a document in Islamabad and one in Punjab to different authorities and rates (AC-1)', async () => {
    const isb = await kit.tax.calculateSalesTax(kit.db, {
      locationId: kit.islamabadId,
      supplyKind: 'services',
      date: DATE,
      lines,
    });
    const lhr = await kit.tax.calculateSalesTax(kit.db, {
      locationId: kit.lahoreId,
      supplyKind: 'services',
      date: DATE,
      lines,
    });
    expect([isb.authorityCode, isb.taxTotal, isb.registrationNumber]).toEqual([
      'FBR',
      '100.00',
      'TEST-FBR-0001',
    ]);
    expect([lhr.authorityCode, lhr.taxTotal, lhr.registrationNumber]).toEqual([
      'PRA',
      '50.00',
      'TEST-PRA-0001',
    ]);
    expect(isb.region).toBe('islamabad');
  });

  it('prefers the rule for the nature and states every rule used in the snapshot (BR-7, T-6)', async () => {
    const result = await kit.tax.calculateSalesTax(kit.db, {
      locationId: kit.islamabadId,
      supplyKind: 'services',
      date: DATE,
      lines: [
        { id: 'a', amount: '1000.00', nature: 'civil' },
        { id: 'b', amount: '500.00', nature: 'unlisted' },
        { id: 'c', amount: '500.00' },
      ],
    });
    expect(result.taxLines.map((g) => [g.taxCode, g.ratePercent, g.base, g.tax])).toEqual([
      ['FBR-CIVIL', '8.0000', '1000.00', '80.00'],
      ['FBR-ST', '10.0000', '1000.00', '100.00'],
    ]);
    expect(result).toMatchObject({
      base: '2000.00',
      taxTotal: '180.00',
      total: '2180.00',
      date: DATE,
      roundingMode: 'per_document',
      pricesIncludeTax: false,
    });
    expect(result.rules.map((rule) => [rule.taxCode, rule.nature, rule.effectiveFrom])).toEqual([
      ['FBR-CIVIL', 'civil', FROM],
      ['FBR-ST', null, FROM],
    ]);
  });

  it('honours the company settings and a per-document override of the price basis', async () => {
    await kit.db.query("update tax_settings set value = 'true' where key = 'prices_include_tax'");
    const inclusive = await kit.tax.calculateSalesTax(kit.db, {
      locationId: kit.islamabadId,
      supplyKind: 'services',
      date: DATE,
      lines: [{ id: 'l', amount: '1100.00' }],
    });
    expect(inclusive).toMatchObject({
      pricesIncludeTax: true,
      base: '1000.00',
      taxTotal: '100.00',
    });
    const exclusive = await kit.tax.calculateSalesTax(kit.db, {
      locationId: kit.islamabadId,
      supplyKind: 'services',
      date: DATE,
      lines: [{ id: 'l', amount: '1000.00' }],
      pricesIncludeTax: false,
    });
    expect(exclusive).toMatchObject({ pricesIncludeTax: false, total: '1100.00' });
    await kit.db.query("update tax_settings set value = 'false' where key = 'prices_include_tax'");
  });

  it('switches to per-line rounding from the setting', async () => {
    await kit.db.query("update tax_settings set value = 'per_line' where key = 'rounding_mode'");
    const result = await kit.tax.calculateSalesTax(kit.db, {
      locationId: kit.islamabadId,
      supplyKind: 'services',
      date: DATE,
      lines: [
        { id: '1', amount: '0.05' },
        { id: '2', amount: '0.05' },
        { id: '3', amount: '0.05' },
      ],
    });
    expect(result.taxTotal).toBe('0.03');
    await kit.db.query(
      "update tax_settings set value = 'per_document' where key = 'rounding_mode'",
    );
  });

  it('lists what is in force on a date', async () => {
    const rules = await kit.tax.getTaxRules(kit.db, DATE);
    expect(rules.date).toBe(DATE);
    expect(rules.regionMap).toHaveLength(3);
    expect(rules.salesRules.map((rule) => rule.taxCode).sort()).toEqual([
      'FBR-CIVIL',
      'FBR-ST',
      'PRA-ST',
    ]);
    expect(rules.withholdingRules).toEqual([]);
    expect(rules.settings.roundingMode).toBe('per_document');
    const before = await kit.tax.getTaxRules(kit.db, '2025-12-31');
    expect([before.regionMap, before.salesRules]).toEqual([[], []]);
  });

  it('never changes a stored result when the rule is later succeeded (AC-3)', async () => {
    const issued = await kit.tax.calculateSalesTax(kit.db, {
      locationId: kit.islamabadId,
      supplyKind: 'services',
      date: DATE,
      lines,
    });
    const stored = JSON.stringify(issued);
    await kit.approveSales({
      ...TEST_SALES,
      authorityCode: 'FBR',
      ratePercent: '12',
      taxCode: 'FBR-ST',
      effectiveFrom: '2026-09-01',
    });
    // The stored snapshot is a plain value: it keeps the rule id and the rate it was issued with.
    expect(JSON.parse(stored)).toMatchObject({ taxTotal: '100.00' });
    // The old rule still answers for old dates and the new one for new dates.
    const again = await kit.tax.calculateSalesTax(kit.db, {
      locationId: kit.islamabadId,
      supplyKind: 'services',
      date: DATE,
      lines,
    });
    // Same figures, same rule, same rate; only the closing date of the old rule differs.
    const figures = ({ rules, ...rest }: typeof again) => ({
      ...rest,
      rules: rules.map(({ effectiveTo: _closed, ...rule }) => rule),
    });
    expect(figures(again)).toEqual(figures(issued));
    const later = await kit.tax.calculateSalesTax(kit.db, {
      locationId: kit.islamabadId,
      supplyKind: 'services',
      date: '2026-09-01',
      lines,
    });
    expect(later.taxTotal).toBe('120.00');
  });
});

describe('withholding (T-4)', () => {
  const rule = {
    authorityCode: 'FBR',
    nature: 'civil',
    effectiveFrom: FROM,
  } as const;
  const input = {
    authorityCode: 'FBR',
    nature: 'civil',
    date: DATE,
    invoiceTotal: '1100.00',
    taxAmount: '100.00',
    base: '1000.00',
  } as const;

  it('returns nothing while no withholding rule exists (H-03 default)', async () => {
    expect(
      await kit.tax.calculateWithholding(kit.db, { ...input, direction: 'client_withholds' }),
    ).toEqual([]);
  });

  it('applies every matching rule on its own base and ignores the rest', async () => {
    await kit.approveWithholding({
      ...rule,
      direction: 'client_withholds',
      ratePercent: '10',
      base: 'on_invoice_total',
    });
    await kit.approveWithholding({
      ...rule,
      direction: 'client_withholds',
      nature: 'civil',
      partyType: 'client',
      ratePercent: '50',
      base: 'on_tax_amount',
    });
    await kit.approveWithholding({
      ...rule,
      direction: 'we_withhold',
      partyType: 'vendor',
      ratePercent: '2',
      base: 'on_base',
    });
    await kit.approveWithholding({
      ...rule,
      direction: 'client_withholds',
      nature: 'other-nature',
      ratePercent: '1',
      base: 'on_base',
    });

    const client = await kit.tax.calculateWithholding(kit.db, {
      ...input,
      direction: 'client_withholds',
      partyType: 'client',
    });
    expect(client.map((r) => [r.basis, r.baseAmount, r.amount]).sort()).toEqual([
      ['on_invoice_total', '1100.00', '110.00'],
      ['on_tax_amount', '100.00', '50.00'],
    ]);
    // A rule with a party type does not apply to another type or to none.
    const noParty = await kit.tax.calculateWithholding(kit.db, {
      ...input,
      direction: 'client_withholds',
    });
    expect(noParty.map((r) => r.amount)).toEqual(['110.00']);
    const ours = await kit.tax.calculateWithholding(kit.db, {
      ...input,
      direction: 'we_withhold',
      partyType: 'vendor',
    });
    expect(ours.map((r) => r.amount)).toEqual(['20.00']);
    expect(
      await kit.tax.calculateWithholding(kit.db, {
        ...input,
        direction: 'we_withhold',
        authorityCode: 'PRA',
      }),
    ).toEqual([]);
    expect(
      await kit.tax.calculateWithholding(kit.db, {
        ...input,
        direction: 'we_withhold',
        partyType: 'vendor',
        date: '2025-12-31',
      }),
    ).toEqual([]);
    expect((await kit.tax.getTaxRules(kit.db, DATE)).withholdingRules).toHaveLength(4);
    expect((await kit.tax.getTaxRules(kit.db, '2025-12-31')).withholdingRules).toEqual([]);
  });
});

describe('tax report (T-7, BR-8)', () => {
  it('is empty until a module registers its snapshot view', async () => {
    const report = await kit.tax.taxReportData(kit.db, 'FBR', '2026-10');
    expect(report).toMatchObject({
      authorityCode: 'FBR',
      month: '2026-10',
      outputTax: { base: '0.00', tax: '0.00', documents: 0 },
    });
  });

  it('aggregates scripted snapshots from every registered source, for the month asked', async () => {
    const asked: unknown[] = [];
    kit.tax.registerReportSource({
      rows: async (_db, query) => {
        asked.push(query);
        return [
          { documentId: 'i1', kind: 'invoice', date: '2026-02-03', base: '1000.00', tax: '100.00' },
          {
            documentId: 'c1',
            kind: 'credit_note',
            date: '2026-02-10',
            base: '100.00',
            tax: '10.00',
          },
        ];
      },
    });
    kit.tax.registerReportSource({
      rows: async () => [
        { documentId: 'b1', kind: 'vendor_bill', date: '2026-02-11', base: '400.00', tax: '40.00' },
        {
          documentId: 'w1',
          kind: 'withholding_deducted',
          date: '2026-02-12',
          base: '400.00',
          tax: '8.00',
        },
      ],
    });
    const report = await kit.tax.taxReportData(kit.db, 'FBR', '2026-02');
    expect(asked).toEqual([{ authorityCode: 'FBR', from: '2026-02-01', to: '2026-02-28' }]);
    expect(report).toMatchObject({
      outputTax: { base: '900.00', tax: '90.00', documents: 2 },
      inputTax: { base: '400.00', tax: '40.00', documents: 1 },
      withholdingDeducted: { base: '400.00', tax: '8.00', documents: 1 },
      withholdingSuffered: { documents: 0 },
    });
    await kit.tax.taxReportData(kit.db, 'FBR', '2028-02');
    expect(asked.at(-1)).toMatchObject({ to: '2028-02-29' });
  });

  it('rejects a bad month and an unknown authority', async () => {
    await expect(kit.tax.taxReportData(kit.db, 'FBR', '2026-13')).rejects.toMatchObject({
      code: 'invalid_month',
    });
    await expect(kit.tax.taxReportData(kit.db, 'NOPE', '2026-10')).rejects.toMatchObject({
      code: 'tax_authority_unknown',
    });
  });
});
