import type {
  SupplyKind,
  TaxRegion,
  TaxRoundingMode,
  TaxRuleStatus,
  WithholdingBase,
  WithholdingDirection,
} from '@emporium/shared';
import { request } from '../admin/api';

export interface Authority {
  code: string;
  name: string;
  registrationType: string;
}

interface Decided {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
  status: TaxRuleStatus;
}

export interface SalesRule extends Decided {
  authorityCode: string;
  supplyKind: SupplyKind;
  nature: string | null;
  ratePercent: string;
  taxCode: string;
}

export interface RegionEntry extends Decided {
  region: TaxRegion;
  supplyKind: SupplyKind;
  authorityCode: string;
}

export interface WithholdingRule extends Decided {
  direction: WithholdingDirection;
  authorityCode: string;
  partyType: string | null;
  nature: string;
  ratePercent: string;
  base: WithholdingBase;
}

export interface TaxSettings {
  roundingMode: TaxRoundingMode;
  pricesIncludeTax: boolean;
}

export interface RulesOverview {
  items: SalesRule[];
  authorities: Authority[];
  regionMap: RegionEntry[];
  settings: TaxSettings;
}

interface RangeBody {
  authorityCode: string;
  effectiveFrom: string;
  effectiveTo?: string | undefined;
  note?: string | undefined;
}

export interface SalesRuleBody extends RangeBody {
  supplyKind: SupplyKind;
  nature?: string | undefined;
  ratePercent: string;
  taxCode: string;
}

export interface RegionBody extends RangeBody {
  region: TaxRegion;
  supplyKind: SupplyKind;
}

export interface WithholdingBody extends RangeBody {
  direction: WithholdingDirection;
  partyType?: string | undefined;
  nature: string;
  ratePercent: string;
  base: WithholdingBase;
}

export interface ReportTotals {
  base: string;
  tax: string;
  documents: number;
}

export interface TaxReport {
  authorityCode: string;
  month: string;
  outputTax: ReportTotals;
  inputTax: ReportTotals;
  withholdingDeducted: ReportTotals;
  withholdingSuffered: ReportTotals;
}

export const taxApi = {
  overview: () => request<RulesOverview>('GET', '/tax/rules'),
  requestRule: (body: SalesRuleBody) => request<SalesRule>('POST', '/tax/rules', body),
  requestRegion: (body: RegionBody) => request<RegionEntry>('POST', '/tax/region-map', body),
  withholding: () => request<{ items: WithholdingRule[] }>('GET', '/tax/withholding-rules'),
  requestWithholding: (body: WithholdingBody) =>
    request<WithholdingRule>('POST', '/tax/withholding-rules', body),
  report: (authority: string, month: string) =>
    request<TaxReport>(
      'GET',
      `/tax/reports?authority=${encodeURIComponent(authority)}&month=${encodeURIComponent(month)}`,
    ),
};
