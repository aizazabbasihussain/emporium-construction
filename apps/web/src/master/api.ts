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
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Versioned {
  version: number;
}

export interface Company extends Versioned {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
}

export interface Registration extends Versioned {
  id: string;
  authority: string;
  registrationType: RegistrationType;
  number: string;
  validFrom: string;
  validTo: string | null;
}

export interface Party extends Versioned {
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
}

export interface DuplicateInfo {
  id: string;
  code: string;
  name: string;
  reason: 'name_phone' | 'ntn' | 'cnic';
  blocking: boolean;
}

export interface Unit extends Versioned {
  code: string;
  name: string;
  kind: UnitKind;
}

export interface Conversion extends Versioned {
  id: string;
  fromUnit: string;
  toUnit: string;
  factor: string;
}

export interface Category extends Versioned {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
}

export interface Item extends Versioned {
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
}

export interface CostCode extends Versioned {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  kind: CostCodeKind;
  active: boolean;
}

export interface Location extends Versioned {
  id: string;
  name: string;
  region: Region;
  city: string;
}

export interface VendorPrice extends Versioned {
  id: string;
  vendorId: string;
  itemId: string;
  unitCode: string;
  rate: string;
  validFrom: string;
  validTo: string | null;
}

export type ListParams = Record<string, string | number | undefined>;

const query = (params: ListParams): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
};

export const masterApi = {
  list: <T>(path: string, params: ListParams = {}) =>
    request<Page<T>>('GET', `${path}?${query(params)}`),
  /** Every row of a small reference list, page by page (the API pages at 200). */
  async listAll<T>(path: string, params: ListParams = {}): Promise<T[]> {
    const rows: T[] = [];
    for (;;) {
      const page = await masterApi.list<T>(path, { ...params, limit: 200, offset: rows.length });
      rows.push(...page.items);
      if (page.items.length === 0 || rows.length >= page.total) return rows;
    }
  },
  create: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  update: <T>(path: string, id: string, body: unknown) => request<T>('PUT', `${path}/${id}`, body),
  remove: (path: string, id: string, version: number) =>
    request<unknown>('DELETE', `${path}/${id}?version=${version}`),
  company: () => request<Company>('GET', '/master/company'),
  saveCompany: (body: unknown) => request<Company>('PUT', '/master/company', body),
  checkDuplicate: (body: unknown) =>
    request<{ duplicates: DuplicateInfo[] }>('POST', '/master/parties/check-duplicate', body),
  convert: (quantity: string, from: string, to: string) =>
    request<{ quantity: string; unit: string }>(
      'GET',
      `/master/units/convert?${query({ quantity, from, to })}`,
    ),
};
