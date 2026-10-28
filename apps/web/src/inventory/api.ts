import type {
  CountStatus,
  InventoryMovementType,
  Ownership,
  StoreKind,
  TransferStatus,
} from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Store {
  id: string;
  code: string;
  name: string;
  kind: StoreKind;
  projectId: string | null;
  active: boolean;
  version: number;
}

export interface Stock {
  storeId: string;
  itemId: string;
  ownership: Ownership;
  ownerPartyId: string | null;
  quantity: string;
}

export interface LedgerRow {
  id: string;
  seq: number;
  storeId: string;
  itemId: string;
  ownership: Ownership;
  movementType: InventoryMovementType;
  quantity: string;
  unitCost: string | null;
  value: string | null;
  sourceDocType: string;
  businessDate: string;
}

export interface Movement {
  id: string;
  quantity: string;
  value: string | null;
  costEntryId: string | null;
}

export interface TransferLine {
  id: string;
  itemId: string;
  ownership: Ownership;
  quantity: string;
}

export interface Transfer {
  id: string;
  number: string;
  fromStoreId: string;
  toStoreId: string;
  status: TransferStatus;
  businessDate: string;
  version: number;
  lines: TransferLine[];
}

export interface CountLine {
  id: string;
  itemId: string;
  systemQty: string;
  countedQty: string;
}

export interface Count {
  id: string;
  number: string;
  storeId: string;
  status: CountStatus;
  countedOn: string;
  version: number;
  lines: CountLine[];
}

export interface ClientMaterial {
  storeId: string;
  itemId: string;
  received: string;
  used: string;
  returned: string;
  balance: string;
}

export interface IssueBody {
  storeId: string;
  itemId: string;
  quantity: string;
  ownership?: Ownership;
  ownerPartyId?: string;
  costObject: { type: 'project'; id: string };
  costCodeId?: string;
  businessDate: string;
  note?: string;
}

export interface StockFilter {
  storeId?: string | undefined;
  itemId?: string | undefined;
  ownership?: Ownership | undefined;
  movementType?: InventoryMovementType | undefined;
}

const query = (filter: StockFilter): string => {
  const params = new URLSearchParams({ limit: '200' });
  for (const [key, value] of Object.entries(filter) as [string, string | undefined][]) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  return params.toString();
};

const base = '/inventory';

export const inventoryApi = {
  stores: () => request<Page<Store>>('GET', `${base}/stores?limit=200`),
  stock: (filter: StockFilter) => request<Page<Stock>>('GET', `${base}/stock?${query(filter)}`),
  ledger: (filter: StockFilter) =>
    request<Page<LedgerRow>>('GET', `${base}/ledger?${query(filter)}`),
  issue: (body: IssueBody) => request<Movement>('POST', `${base}/issues`, body),
  transfers: () => request<Page<Transfer>>('GET', `${base}/transfers?limit=200`),
  createTransfer: (body: {
    fromStoreId: string;
    toStoreId: string;
    businessDate: string;
    lines: { itemId: string; quantity: string }[];
  }) => request<Transfer>('POST', `${base}/transfers`, body),
  transferAction: (id: string, action: 'send' | 'receive' | 'cancel', version: number) =>
    request<Transfer>('POST', `${base}/transfers/${id}/${action}`, { version }),
  counts: () => request<Page<Count>>('GET', `${base}/counts?limit=200`),
  createCount: (body: {
    storeId: string;
    countedOn: string;
    lines: { itemId: string; countedQty: string }[];
  }) => request<Count>('POST', `${base}/counts`, body),
  countAction: (id: string, action: 'submit' | 'cancel', version: number) =>
    request<Count>('POST', `${base}/counts/${id}/${action}`, { version }),
  clientMaterial: (projectId: string) =>
    request<ClientMaterial[]>('GET', `${base}/client-material/${projectId}`),
};
