import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTaxKit, uid, type TaxKit } from '../test-support.js';
import {
  closeRule,
  decideRule,
  findRule,
  insertRegionEntry,
  insertSalesRule,
  insertWithholdingRule,
  listAuthorities,
  listRules,
  listSettings,
} from './tax.repo.js';

// Repository functions against PGlite with every migration applied (constitution 10.2).

let kit: TaxKit;
beforeAll(async () => {
  kit = await createTaxKit();
}, 60_000);
afterAll(() => kit.close());

const at = new Date('2026-11-17T10:00:00Z');
const common = (n: number) => ({
  id: uid(8000 + n),
  authorityCode: 'FBR',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  note: null,
  requestedBy: uid(3),
  at,
});

describe('reference data', () => {
  it('lists the authorities and the settings', async () => {
    expect(await listAuthorities(kit.db)).toEqual([
      { code: 'FBR', name: 'Federal Board of Revenue', registration_type: 'strn' },
      { code: 'PRA', name: 'Punjab Revenue Authority', registration_type: 'pra' },
    ]);
    expect(await listSettings(kit.db)).toEqual(
      expect.arrayContaining([{ key: 'rounding_mode', value: 'per_document' }]),
    );
  });
});

describe('sales rules', () => {
  it('inserts, finds, lists by status, decides and closes', async () => {
    const row = await insertSalesRule(kit.db, {
      ...common(1),
      supplyKind: 'services',
      nature: 'repo',
      ratePercent: '7.5',
      taxCode: 'R1',
    });
    expect(row).toMatchObject({
      id: uid(8001),
      status: 'pending_approval',
      rate_percent: '7.5000',
      nature: 'repo',
      tax_code: 'R1',
      effective_from: '2026-01-01',
      effective_to: null,
      requested_by: uid(3),
      approved_by: null,
    });
    expect(await findRule(kit.db, 'sales', uid(8001), true)).toEqual(row);
    expect(await findRule(kit.db, 'sales', uid(8999))).toBeUndefined();
    expect((await listRules(kit.db, 'sales', 'pending_approval')).map((r) => r.id)).toEqual([
      uid(8001),
    ]);
    expect(await listRules(kit.db, 'sales', 'active')).toEqual([]);

    await decideRule(kit.db, 'sales', uid(8001), { status: 'active', approvedBy: uid(2) });
    await closeRule(kit.db, 'sales', uid(8001), '2026-06-30');
    expect(await findRule(kit.db, 'sales', uid(8001))).toMatchObject({
      status: 'active',
      approved_by: uid(2),
      effective_to: '2026-06-30',
    });
  });

  it('lists newest start first, across statuses when none is given', async () => {
    await insertSalesRule(kit.db, {
      ...common(2),
      effectiveFrom: '2027-01-01',
      supplyKind: 'goods',
      nature: null,
      ratePercent: '0',
      taxCode: 'R2',
    });
    const all = await listRules(kit.db, 'sales');
    expect(all.map((r) => r.id)).toEqual([uid(8002), uid(8001)]);
  });
});

describe('withholding rules', () => {
  it('inserts, finds and rejects', async () => {
    const row = await insertWithholdingRule(kit.db, {
      ...common(3),
      direction: 'client_withholds',
      partyType: 'client',
      nature: 'repo',
      ratePercent: '2.25',
      base: 'on_invoice_total',
    });
    expect(row).toMatchObject({
      direction: 'client_withholds',
      party_type: 'client',
      rate_percent: '2.2500',
      base: 'on_invoice_total',
      status: 'pending_approval',
    });
    await decideRule(kit.db, 'withholding', uid(8003), { status: 'rejected', approvedBy: null });
    expect(await findRule(kit.db, 'withholding', uid(8003))).toMatchObject({
      status: 'rejected',
      approved_by: null,
    });
    expect((await listRules(kit.db, 'withholding', 'rejected')).map((r) => r.id)).toEqual([
      uid(8003),
    ]);
  });
});

describe('region map', () => {
  it('inserts, finds and closes', async () => {
    const row = await insertRegionEntry(kit.db, {
      ...common(4),
      region: 'punjab',
      supplyKind: 'services',
    });
    expect(row).toMatchObject({ region: 'punjab', supply_kind: 'services', authority_code: 'FBR' });
    await closeRule(kit.db, 'region', uid(8004), '2026-12-31');
    expect(await findRule(kit.db, 'region', uid(8004), true)).toMatchObject({
      effective_to: '2026-12-31',
    });
    expect((await listRules(kit.db, 'region')).map((r) => r.id)).toEqual([uid(8004)]);
  });
});
