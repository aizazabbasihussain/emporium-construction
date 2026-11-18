import type {
  SupplyKind,
  TaxRegion,
  TaxRoundingMode,
  TaxRuleKind,
  TaxRuleStatus,
  WithholdingBase,
  WithholdingDirection,
} from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { Db };

/** Who is acting. Permissions are checked at the route; services only need the identity. */
export interface Actor {
  userId: string;
  requestId: string | null;
}

export interface AuthorityDto {
  code: string;
  name: string;
  registrationType: string;
}

interface RuleDecision {
  status: TaxRuleStatus;
  requestedBy: string | null;
  approvedBy: string | null;
  note: string | null;
}

export interface RegionMapDto extends RuleDecision {
  id: string;
  region: TaxRegion;
  supplyKind: SupplyKind;
  authorityCode: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface SalesRuleDto extends RuleDecision {
  id: string;
  authorityCode: string;
  supplyKind: SupplyKind;
  nature: string | null;
  ratePercent: string;
  taxCode: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface WithholdingRuleDto extends RuleDecision {
  id: string;
  direction: WithholdingDirection;
  authorityCode: string;
  partyType: string | null;
  nature: string;
  ratePercent: string;
  base: WithholdingBase;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface TaxSettingsDto {
  roundingMode: TaxRoundingMode;
  pricesIncludeTax: boolean;
}

export type { TaxRuleKind };
