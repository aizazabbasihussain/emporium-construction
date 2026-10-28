import type {
  CostCodeKind,
  DefaultTaxKind,
  ItemKind,
  PartyRole,
  PartyStatus,
  Region,
  RegistrationType,
  UnitKind,
} from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { Db };

/** Who is acting. Permissions are checked at the route; services only need the identity. */
export interface Actor {
  userId: string;
  requestId: string | null;
}

export interface Page {
  limit: number;
  offset: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface CompanyDto {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  logoFileId: string | null;
  version: number;
}

export interface RegistrationDto {
  id: string;
  authority: string;
  registrationType: RegistrationType;
  number: string;
  validFrom: string;
  validTo: string | null;
  version: number;
}

export interface ContactDto {
  name: string;
  phone: string | null;
  email: string | null;
  role: string | null;
}

export interface PartyDto {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  roles: PartyRole[];
  ntn: string | null;
  strn: string | null;
  cnic: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  status: PartyStatus;
  notes: string | null;
  contacts: ContactDto[];
  version: number;
}

export interface UnitDto {
  code: string;
  name: string;
  kind: UnitKind;
  version: number;
}

export interface ConversionDto {
  id: string;
  fromUnit: string;
  toUnit: string;
  factor: string;
  version: number;
}

export interface CategoryDto {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  version: number;
}

export interface ItemDto {
  id: string;
  code: string;
  name: string;
  categoryId: string | null;
  unitCode: string;
  itemKind: ItemKind;
  stockable: boolean;
  defaultTaxKind: DefaultTaxKind;
  reorderLevel: string | null;
  defaultCostCodeId: string | null;
  active: boolean;
  version: number;
}

export interface CostCodeDto {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  kind: CostCodeKind;
  active: boolean;
  version: number;
}

export interface LocationDto {
  id: string;
  name: string;
  region: Region;
  city: string;
  version: number;
}

export interface VendorPriceDto {
  id: string;
  vendorId: string;
  itemId: string;
  unitCode: string;
  rate: string;
  validFrom: string;
  validTo: string | null;
  version: number;
}

/** BR-8: each module that stores documents against a party or item registers a check for it. */
export type IsReferenced = (db: Db, id: string) => Promise<boolean>;

/** BR-6: the cost ledger (P1-09) tells whether a cost code has posted costs and open budget lines. */
export type CostCodeUsage = (
  db: Db,
  costCodeId: string,
) => Promise<{ postedCosts: boolean; openBudgetLines: boolean }>;
