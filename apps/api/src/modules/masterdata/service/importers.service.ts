import { ValidationError } from '@emporium/domain';
import type { ColumnDef } from '@emporium/domain/importer';
import { normalizeCnic, normalizePhone, normalizeTaxNumber } from '@emporium/domain/masterdata';
import {
  costCodeKinds,
  itemKinds,
  partyRoles,
  partyStatuses,
  registrationTypes,
  taxKinds,
  unitKinds,
} from '@emporium/shared';
import { z } from 'zod';
import type { ApplyContext, ImporterDefinition } from '../../importer/index.js';
import { findCategoryByCode, findItemByCode } from '../repo/catalog.repo.js';
import { findCostCodeByCode } from '../repo/costing.repo.js';
import { findPartyByCode } from '../repo/parties.repo.js';
import type { Actor } from '../types.js';
import type { CatalogService } from './catalog.service.js';
import type { CompanyService } from './company.service.js';
import type { CostingService } from './costing.service.js';
import type { PartiesService } from './parties.service.js';

export type RegisterImporter = <T>(definition: ImporterDefinition<T>) => void;

const text = (name: string, example: string, required = false, note?: string): ColumnDef => ({
  name,
  type: 'text',
  required,
  example,
  maxLength: 500,
  ...(note === undefined ? {} : { note }),
});

const choice = (
  name: string,
  allowed: readonly string[],
  example: string,
  required = false,
): ColumnDef => ({ name, type: 'enum', required, example, allowed });

const optionalText = z.string().nullable();

/** Runs a domain normalizer and reports its message as a row error (same rules as the API). */
const normalized = (normalize: (value: string) => string) =>
  optionalText.transform((value, ctx) => {
    if (value === null) return null;
    try {
      return normalize(value);
    } catch (error) {
      // The normalizers only throw domain validation errors, whose message names the problem.
      ctx.addIssue({ code: 'custom', message: (error as Error).message });
      return z.NEVER;
    }
  });

const actorOf = (ctx: ApplyContext): Actor => ({
  userId: ctx.actorUserId,
  requestId: ctx.requestId,
});

/** A referenced code that is not in the master data is a row problem, not a crash. */
export function requireFound<T>(row: T | undefined, what: string, code: string): T {
  if (row === undefined) {
    throw new ValidationError(`${what}_unknown`, `${what} ${code} does not exist`);
  }
  return row;
}

/**
 * Puts rows whose parent code is also in the file after that parent. A parent outside the file is
 * looked up in the master data when the row is applied.
 */
export function parentsFirst<T extends { code: string; parent_code: string | null }>(
  rows: readonly T[],
): T[] {
  const byCode = new Map(rows.map((row) => [row.code, row]));
  const ordered: T[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (row: T) => {
    const seen = state.get(row.code);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      throw new ValidationError('hierarchy_cycle', `Parent codes form a loop at ${row.code}`);
    }
    state.set(row.code, 'visiting');
    const parent = row.parent_code === null ? undefined : byCode.get(row.parent_code);
    if (parent !== undefined) visit(parent);
    state.set(row.code, 'done');
    ordered.push(row);
  };
  rows.forEach(visit);
  return ordered;
}

const partySchema = z.object({
  name: z.string(),
  legal_name: optionalText,
  roles: z.string().transform((value, ctx) => {
    const roles = value
      .split(/[;,|]/)
      .map((role) => role.trim().toLowerCase())
      .filter((role) => role !== '');
    const bad = roles.find((role) => !(partyRoles as readonly string[]).includes(role));
    if (roles.length === 0 || bad !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `Use roles from: ${partyRoles.join(', ')} (separate several with ;)`,
      });
      return z.NEVER;
    }
    return roles;
  }),
  ntn: normalized(normalizeTaxNumber),
  strn: normalized(normalizeTaxNumber),
  cnic: normalized(normalizeCnic),
  phone: normalized(normalizePhone),
  email: optionalText,
  address: optionalText,
  city: optionalText,
  status: optionalText,
  notes: optionalText,
});

const unitSchema = z.object({ code: z.string(), name: z.string(), kind: z.string() });
const categorySchema = z.object({
  code: z.string(),
  name: z.string(),
  parent_code: optionalText,
});
const itemSchema = z.object({
  code: z.string(),
  name: z.string(),
  category_code: optionalText,
  unit: z.string(),
  item_kind: z.string(),
  stockable: z.boolean().nullable(),
  default_tax_kind: z.string(),
  reorder_level: optionalText,
  default_cost_code: optionalText,
  active: z.boolean().nullable(),
});
const costCodeSchema = z.object({
  code: z.string(),
  name: z.string(),
  parent_code: optionalText,
  kind: z.string(),
  active: z.boolean().nullable(),
});
const priceSchema = z.object({
  vendor_code: z.string(),
  item_code: z.string(),
  unit: z.string(),
  rate: z.string(),
  valid_from: z.string(),
  valid_to: optionalText,
});
const registrationSchema = z.object({
  authority: z.string(),
  registration_type: z.string(),
  number: z.string(),
  valid_from: z.string(),
  valid_to: optionalText,
});

/** BR-10: one importer per master. Each row goes through the same service as the API. */
export function registerMasterImporters(
  register: RegisterImporter,
  services: {
    parties: PartiesService;
    catalog: CatalogService;
    costing: CostingService;
    company: CompanyService;
  },
): void {
  const { parties, catalog, costing, company } = services;

  register({
    code: 'parties',
    label: 'Clients, vendors and subcontractors',
    schema: partySchema,
    columns: [
      text('name', 'Example Traders', true),
      text('legal_name', 'Example Traders (Pvt) Ltd'),
      text(
        'roles',
        'vendor',
        true,
        'client, vendor, subcontractor or labour_contractor; separate several with ;',
      ),
      text('ntn', '1234567-8'),
      text('strn', ''),
      text('cnic', ''),
      text('phone', '0300 1234567'),
      text('email', 'info@example.test'),
      text('address', 'Plot 1, Example Road'),
      text('city', 'Islamabad'),
      choice('status', partyStatuses, 'active'),
      text('notes', ''),
    ],
    async apply(rows, ctx, tx) {
      for (const row of rows) {
        await parties.create(
          {
            name: row.name,
            legalName: row.legal_name,
            roles: row.roles,
            ntn: row.ntn,
            strn: row.strn,
            cnic: row.cnic,
            phone: row.phone,
            email: row.email,
            address: row.address,
            city: row.city,
            status: row.status ?? undefined,
            notes: row.notes,
          },
          actorOf(ctx),
          tx,
        );
      }
    },
  });

  register({
    code: 'units',
    label: 'Units of measure',
    schema: unitSchema,
    columns: [
      text('code', 'nos', true),
      text('name', 'Numbers', true),
      choice('kind', unitKinds, 'count', true),
    ],
    async apply(rows, ctx, tx) {
      for (const row of rows) await catalog.createUnit(row, actorOf(ctx), tx);
    },
  });

  register({
    code: 'item_categories',
    label: 'Item categories',
    schema: categorySchema,
    columns: [
      text('code', 'CEM', true),
      text('name', 'Cement', true),
      text('parent_code', '', false, 'Code of the parent category, empty for a top-level one'),
    ],
    async apply(rows, ctx, tx) {
      for (const row of parentsFirst(rows)) {
        const parent =
          row.parent_code === null
            ? null
            : requireFound(
                await findCategoryByCode(tx, row.parent_code),
                'parent',
                row.parent_code,
              );
        await catalog.createCategory(
          { code: row.code, name: row.name, parentId: parent?.id ?? null },
          actorOf(ctx),
          tx,
        );
      }
    },
  });

  register({
    code: 'items',
    label: 'Items',
    schema: itemSchema,
    columns: [
      text('code', 'ITM-0001', true),
      text('name', 'Portland cement 50 kg bag', true),
      text('category_code', 'CEM', false, 'Import item categories first'),
      text('unit', 'bag', true),
      choice('item_kind', itemKinds, 'material', true),
      { name: 'stockable', type: 'boolean', required: false, example: 'yes' },
      choice('default_tax_kind', taxKinds, 'goods', true),
      { name: 'reorder_level', type: 'decimal', required: false, example: '100' },
      text('default_cost_code', '101', false, 'Cost code the issues of this item are charged to'),
      { name: 'active', type: 'boolean', required: false, example: 'yes' },
    ],
    async apply(rows, ctx, tx) {
      for (const row of rows) {
        const category =
          row.category_code === null
            ? null
            : requireFound(
                await findCategoryByCode(tx, row.category_code),
                'category',
                row.category_code,
              );
        const costCode =
          row.default_cost_code === null
            ? null
            : requireFound(
                await findCostCodeByCode(tx, row.default_cost_code),
                'cost_code',
                row.default_cost_code,
              );
        await catalog.createItem(
          {
            code: row.code,
            name: row.name,
            categoryId: category?.id ?? null,
            unitCode: row.unit,
            itemKind: row.item_kind,
            stockable: row.stockable ?? undefined,
            defaultTaxKind: row.default_tax_kind,
            reorderLevel: row.reorder_level,
            defaultCostCodeId: costCode?.id ?? null,
            active: row.active ?? undefined,
          },
          actorOf(ctx),
          tx,
        );
      }
    },
  });

  register({
    code: 'cost_codes',
    label: 'Cost codes',
    schema: costCodeSchema,
    columns: [
      text('code', '101', true),
      text('name', 'Cement', true),
      text('parent_code', '100', false, 'Code of the parent cost code, empty for a top-level one'),
      choice('kind', costCodeKinds, 'material', true),
      { name: 'active', type: 'boolean', required: false, example: 'yes' },
    ],
    async apply(rows, ctx, tx) {
      for (const row of parentsFirst(rows)) {
        const parent =
          row.parent_code === null
            ? null
            : requireFound(
                await findCostCodeByCode(tx, row.parent_code),
                'parent',
                row.parent_code,
              );
        await costing.createCostCode(
          {
            code: row.code,
            name: row.name,
            parentId: parent?.id ?? null,
            kind: row.kind,
            active: row.active ?? undefined,
          },
          actorOf(ctx),
          tx,
        );
      }
    },
  });

  register({
    code: 'vendor_prices',
    label: 'Vendor price lists',
    schema: priceSchema,
    dependsOn: ['parties', 'items'],
    columns: [
      text('vendor_code', 'VN-0001', true, 'The code of an imported or entered vendor'),
      text('item_code', 'ITM-0001', true),
      text('unit', 'bag', true),
      { name: 'rate', type: 'decimal', required: true, example: '1250.50' },
      { name: 'valid_from', type: 'date', required: true, example: '2026-01-01' },
      { name: 'valid_to', type: 'date', required: false, example: '' },
    ],
    async apply(rows, ctx, tx) {
      for (const row of rows) {
        const vendor = requireFound(
          await findPartyByCode(tx, row.vendor_code),
          'vendor',
          row.vendor_code,
        );
        const item = requireFound(await findItemByCode(tx, row.item_code), 'item', row.item_code);
        await costing.createPrice(
          {
            vendorId: vendor.id,
            itemId: item.id,
            unitCode: row.unit,
            rate: row.rate,
            validFrom: row.valid_from,
            validTo: row.valid_to,
          },
          actorOf(ctx),
          tx,
        );
      }
    },
  });

  register({
    code: 'tax_registrations',
    label: 'Tax registrations',
    schema: registrationSchema,
    columns: [
      text('authority', 'FBR', true),
      choice('registration_type', registrationTypes, 'ntn', true),
      text('number', 'EXAMPLE-0001', true),
      { name: 'valid_from', type: 'date', required: true, example: '2026-01-01' },
      { name: 'valid_to', type: 'date', required: false, example: '' },
    ],
    async apply(rows, ctx, tx) {
      for (const row of rows) {
        await company.createRegistration(
          {
            authority: row.authority,
            registrationType: row.registration_type,
            number: row.number,
            validFrom: row.valid_from,
            validTo: row.valid_to,
          },
          actorOf(ctx),
          tx,
        );
      }
    },
  });
}
