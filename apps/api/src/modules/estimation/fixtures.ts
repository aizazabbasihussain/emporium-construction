import type { EstimationKit } from './test-support.js';
import type { EstimateLineInput } from './service/estimates.service.js';
import type { TemplateInput } from './service/templates.service.js';

export const tx = <T>(kit: EstimationKit, fn: (db: EstimationKit['db']) => Promise<T>) =>
  kit.db.transaction(fn);

export interface Fixture {
  cementId: string;
  vendorId: string;
  partyId: string;
}

/** A cement item with a vendor price list, and a client; all synthetic. */
export async function seedMasters(kit: EstimationKit): Promise<Fixture> {
  const { masterData, actor } = kit;
  const vendor = await tx(kit, (t) =>
    masterData.parties.create({ name: 'Fixture Vendor', roles: ['vendor'] }, actor, t),
  );
  const client = await tx(kit, (t) =>
    masterData.parties.create({ name: 'Fixture Client', roles: ['client'] }, actor, t),
  );
  const cement = await tx(kit, (t) =>
    masterData.catalog.createItem(
      {
        code: 'EST-CEMENT',
        name: 'Cement',
        unitCode: 'bag',
        itemKind: 'material',
        defaultTaxKind: 'goods',
      },
      actor,
      t,
    ),
  );
  for (const [rate, validFrom, validTo] of [
    ['1100', '2026-01-01', '2026-06-30'],
    ['1250', '2026-07-01', null],
    ['1300', '2027-01-01', null],
  ] as const) {
    await tx(kit, (t) =>
      masterData.costing.createPrice(
        { vendorId: vendor.id, itemId: cement.id, unitCode: 'bag', rate, validFrom, validTo },
        actor,
        t,
      ),
    );
  }
  return { cementId: cement.id, vendorId: vendor.id, partyId: client.id };
}

/**
 * A synthetic boundary wall: 13.5 bricks and 0.2 bags of cement (priced from the vendor list) per
 * sqft, and one labour day per 50 sqft (no rate: it must be priced before locking).
 */
export function wallTemplate(kit: EstimationKit, fixture: Fixture, code = 'WALL'): TemplateInput {
  return {
    code,
    name: 'Boundary wall',
    workType: 'boundary_wall',
    parameters: [
      { key: 'length', label: 'Length', unit: 'ft' },
      { key: 'height', label: 'Height', unit: 'ft' },
    ],
    lines: [
      {
        description: 'Bricks',
        lineKind: 'material',
        costCodeId: kit.costCodes.material,
        unitCode: 'nos',
        qtyFormula: 'ceil(length * height * 13.5)',
        defaultRate: '20',
      },
      {
        description: 'Cement',
        lineKind: 'material',
        itemId: fixture.cementId,
        costCodeId: kit.costCodes.material,
        unitCode: 'bag',
        qtyFormula: 'ceil(length * height * 0.2)',
        defaultRate: '1000',
      },
      {
        description: 'Mason and helper',
        lineKind: 'labour',
        costCodeId: kit.costCodes.labour,
        unitCode: 'day',
        qtyFormula: 'ceil(length * height / 50)',
      },
    ],
  };
}

export const line = (
  kit: EstimationKit,
  over: Partial<EstimateLineInput> = {},
): EstimateLineInput => ({
  description: 'Line',
  lineKind: 'material',
  costCodeId: kit.costCodes.material,
  unitCode: 'nos',
  quantity: '10',
  rate: '5',
  ...over,
});
