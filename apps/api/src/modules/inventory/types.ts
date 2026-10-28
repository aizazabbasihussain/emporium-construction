import type { ScopeGrant } from '@emporium/domain/identity';
import type {
  CountStatus,
  InventoryMovementType,
  Ownership,
  StoreKind,
  TransferStatus,
} from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { Db };

/** Who is acting; a supervisor is limited to the stores of the projects assigned to them. */
export interface Actor {
  userId: string;
  roles: readonly string[];
  scopes: readonly ScopeGrant[];
  permissions: ReadonlySet<string>;
  requestId: string | null;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface StoreDto {
  id: string;
  code: string;
  name: string;
  kind: StoreKind;
  projectId: string | null;
  custodianUserId: string | null;
  active: boolean;
  version: number;
}

export interface StockDto {
  storeId: string;
  itemId: string;
  ownership: Ownership;
  ownerPartyId: string | null;
  quantity: string;
}

export interface LedgerDto {
  id: string;
  seq: number;
  storeId: string;
  itemId: string;
  ownership: Ownership;
  ownerPartyId: string | null;
  movementType: InventoryMovementType;
  quantity: string;
  unitCost: string | null;
  value: string | null;
  costObjectType: string | null;
  costObjectId: string | null;
  sourceDocType: string;
  sourceDocId: string;
  sourceLineId: string | null;
  businessDate: string;
  postedAt: string;
  reversesId: string | null;
}

/** What an issue, return or salvage reports back: the document, the totals and its ledger rows. */
export interface MovementDto {
  id: string;
  storeId: string;
  itemId: string;
  ownership: Ownership;
  quantity: string;
  value: string | null;
  costEntryId: string | null;
  ledger: LedgerDto[];
}

export interface TransferLineDto {
  id: string;
  itemId: string;
  ownership: Ownership;
  ownerPartyId: string | null;
  projectId: string | null;
  quantity: string;
}

export interface TransferDto {
  id: string;
  number: string;
  fromStoreId: string;
  toStoreId: string;
  status: TransferStatus;
  businessDate: string;
  version: number;
  lines: TransferLineDto[];
}

export interface CountLineDto {
  id: string;
  itemId: string;
  ownership: Ownership;
  ownerPartyId: string | null;
  systemQty: string;
  countedQty: string;
}

export interface CountDto {
  id: string;
  number: string;
  storeId: string;
  status: CountStatus;
  countedOn: string;
  version: number;
  lines: CountLineDto[];
}

export interface ClientMaterialDto {
  projectId: string;
  storeId: string;
  itemId: string;
  ownerPartyId: string;
  received: string;
  used: string;
  returned: string;
  balance: string;
}

export interface ReorderLevelDto {
  storeId: string;
  itemId: string;
  level: string;
}

export interface IntegrityDifference {
  storeId: string;
  itemId: string;
  ownership: Ownership;
  ownerPartyId: string | null;
  balance: string;
  ledgerSum: string;
  difference: string;
}

export interface IntegrityReport {
  checked: number;
  differences: IntegrityDifference[];
}

/** The payload of `stock.issued`, `stock.received` and `stock.adjusted` (spec section 2). */
export interface StockEventPayload {
  storeId: string;
  itemId: string;
  ownership: Ownership;
  quantity: string;
  movementType: InventoryMovementType;
  sourceDocType: string;
  sourceDocId: string;
}
