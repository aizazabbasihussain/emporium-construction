import {
  aggregateTaxReport,
  calculateSalesTax,
  calculateWithholding,
  inRange,
  resolveAuthority,
  selectRule,
  type TaxReport,
  type TaxReportRow,
  type TaxResult,
  type WithholdingResult,
} from '@emporium/domain/tax';
import type { SupplyKind, WithholdingDirection } from '@emporium/shared';
import type { MasterData } from '../../masterdata/index.js';
import {
  assertAuthorityKnown,
  assertFound,
  assertMonth,
  assertRegistered,
} from '../policy/tax.policy.js';
import type {
  Db,
  RegionMapDto,
  SalesRuleDto,
  TaxSettingsDto,
  WithholdingRuleDto,
} from '../types.js';
import type { RulesService } from './rules.service.js';

export interface AuthorityResolution {
  authorityCode: string;
  region: string;
  registrationNumber: string;
}

export interface SalesTaxInput {
  locationId: string;
  supplyKind: SupplyKind;
  /** The document date, yyyy-mm-dd. */
  date: string;
  lines: { id: string; amount: string; nature?: string | null | undefined }[];
  /** Overrides the company setting for this document. */
  pricesIncludeTax?: boolean | undefined;
}

/** The value object documents store as their tax snapshot (BR-7). */
export interface TaxSnapshot extends TaxResult {
  authorityCode: string;
  region: string;
  registrationNumber: string;
  date: string;
  rules: {
    id: string;
    authorityCode: string;
    supplyKind: string;
    nature: string | null;
    taxCode: string;
    ratePercent: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }[];
}

export interface WithholdingInput {
  direction: WithholdingDirection;
  authorityCode: string;
  partyType?: string | null | undefined;
  nature: string;
  date: string;
  invoiceTotal: string;
  taxAmount: string;
  base: string;
}

export interface TaxRulesOnDate {
  date: string;
  regionMap: RegionMapDto[];
  salesRules: SalesRuleDto[];
  withholdingRules: WithholdingRuleDto[];
  settings: TaxSettingsDto;
}

/**
 * Rows of stored tax snapshots that an owning module (billing, payables) exposes through its
 * published view (BR-8). The tax module never reads another module's tables itself.
 */
export interface TaxReportSource {
  rows(db: Db, query: { authorityCode: string; from: string; to: string }): Promise<TaxReportRow[]>;
}

export interface TaxReportData extends TaxReport {
  authorityCode: string;
  month: string;
}

export interface EngineService {
  /** BR-1: location and supply kind to an authority the company is registered with. */
  resolveAuthority(
    db: Db,
    query: { locationId: string; supplyKind: SupplyKind; date: string },
  ): Promise<AuthorityResolution>;
  /** BR-2, BR-3, BR-7, BR-9: tax for a document; refuses when a rule is missing. */
  calculateSalesTax(db: Db, input: SalesTaxInput): Promise<TaxSnapshot>;
  /** BR-4: every active rule that matches, each with its amount; none when there is no rule. */
  calculateWithholding(db: Db, input: WithholdingInput): Promise<WithholdingResult[]>;
  getTaxRules(db: Db, date: string): Promise<TaxRulesOnDate>;
  registerReportSource(source: TaxReportSource): void;
  taxReportData(db: Db, authorityCode: string, month: string): Promise<TaxReportData>;
}

export function createEngineService(deps: {
  masterData: Pick<MasterData, 'listLocations' | 'getRegistration'>;
  rules: RulesService;
}): EngineService {
  const { masterData, rules } = deps;
  const sources: TaxReportSource[] = [];

  async function resolve(
    db: Db,
    query: { locationId: string; supplyKind: SupplyKind; date: string },
  ): Promise<AuthorityResolution> {
    const location = assertFound(
      (await masterData.listLocations(db)).find((entry) => entry.id === query.locationId),
      'location',
    );
    const authorityCode = resolveAuthority(await rules.listRegionMap(db, 'active'), {
      region: location.region,
      supplyKind: query.supplyKind,
      date: query.date,
    });
    const registration = assertRegistered(
      await masterData.getRegistration(db, authorityCode, { date: query.date }),
      authorityCode,
      query.date,
    );
    return { authorityCode, region: location.region, registrationNumber: registration.number };
  }

  return {
    resolveAuthority: resolve,

    async calculateSalesTax(db, input) {
      const authority = await resolve(db, input);
      const active = await rules.listSalesRules(db, 'active');
      const settings = await rules.settings(db);
      const used = new Map<string, SalesRuleDto>();
      const lines = input.lines.map((line) => {
        const rule = selectRule(active, {
          authorityCode: authority.authorityCode,
          supplyKind: input.supplyKind,
          nature: line.nature ?? null,
          date: input.date,
        });
        used.set(rule.id, rule);
        return { id: line.id, amount: line.amount, rule };
      });
      const result = calculateSalesTax(lines, {
        roundingMode: settings.roundingMode,
        pricesIncludeTax: input.pricesIncludeTax ?? settings.pricesIncludeTax,
      });
      return {
        ...result,
        ...authority,
        date: input.date,
        rules: [...used.values()].map((rule) => ({
          id: rule.id,
          authorityCode: rule.authorityCode,
          supplyKind: rule.supplyKind,
          nature: rule.nature,
          taxCode: rule.taxCode,
          ratePercent: rule.ratePercent,
          effectiveFrom: rule.effectiveFrom,
          effectiveTo: rule.effectiveTo,
        })),
      };
    },

    async calculateWithholding(db, input) {
      const matching = (await rules.listWithholdingRules(db, 'active')).filter(
        (rule) =>
          rule.direction === input.direction &&
          rule.authorityCode === input.authorityCode &&
          rule.nature === input.nature &&
          (rule.partyType === null || rule.partyType === (input.partyType ?? null)) &&
          inRange(rule, input.date),
      );
      return matching.map((rule) =>
        calculateWithholding(rule, {
          invoiceTotal: input.invoiceTotal,
          taxAmount: input.taxAmount,
          base: input.base,
        }),
      );
    },

    async getTaxRules(db, date) {
      return {
        date,
        regionMap: (await rules.listRegionMap(db, 'active')).filter((rule) => inRange(rule, date)),
        salesRules: (await rules.listSalesRules(db, 'active')).filter((rule) =>
          inRange(rule, date),
        ),
        withholdingRules: (await rules.listWithholdingRules(db, 'active')).filter((rule) =>
          inRange(rule, date),
        ),
        settings: await rules.settings(db),
      };
    },

    registerReportSource(source) {
      sources.push(source);
    },

    async taxReportData(db, authorityCode, month) {
      assertMonth(month);
      assertAuthorityKnown(
        (await rules.authorities(db)).map((authority) => authority.code),
        authorityCode,
      );
      const [year, number] = month.split('-').map(Number) as [number, number];
      const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
      const query = {
        authorityCode,
        from: `${month}-01`,
        to: `${month}-${String(last).padStart(2, '0')}`,
      };
      const rows: TaxReportRow[] = [];
      for (const source of sources) rows.push(...(await source.rows(db, query)));
      return { authorityCode, month, ...aggregateTaxReport(rows) };
    },
  };
}
