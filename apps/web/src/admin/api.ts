const baseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type TokenProvider = () => Promise<string | null>;
let tokenProvider: TokenProvider = () => Promise.resolve(null);

/** The auth layer supplies the current access token; nothing here stores or caches it (BR-9). */
export function setTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await tokenProvider();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data.error?.code ?? 'request_failed',
      data.error?.message ?? 'Request failed',
    );
  }
  return data as T;
}

export interface AuditItem {
  id: string;
  at: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  request_id: string | null;
}

export interface SeriesItem {
  code: string;
  prefix: string;
  padding: number;
  resetYearly: boolean;
  gapless: boolean;
  startValue: number;
  nextValue: number;
  version: number;
}

export interface SettingItem {
  key: string;
  value: number | string | boolean;
  description: string;
  version: number;
}

export const adminApi = {
  audit: (params: { entityType?: string; entityId?: string }) => {
    const query = new URLSearchParams();
    if (params.entityType) query.set('entityType', params.entityType);
    if (params.entityId) query.set('entityId', params.entityId);
    return request<{ items: AuditItem[] }>('GET', `/admin/audit?${query.toString()}`);
  },
  series: () => request<{ items: SeriesItem[] }>('GET', '/admin/number-series'),
  saveSeries: (series: Omit<SeriesItem, 'version'> & { version?: number }) =>
    request<SeriesItem>('POST', '/admin/number-series', series),
  setting: (key: string) => request<SettingItem>('GET', `/admin/settings/${key}`),
  saveSetting: (key: string, value: SettingItem['value'], version: number) =>
    request<SettingItem>('PUT', `/admin/settings/${key}`, { value, version }),
};
