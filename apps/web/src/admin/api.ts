import { summarizeIssues, type ApiIssue } from '../errors/issues';

const baseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Failed field checks when the answer is `validation_failed`. */
    readonly details: ApiIssue[] = [],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; requestId?: string; details?: unknown };
}

/** Builds the error for a failed answer; field problems replace the bare "Request validation failed". */
function apiErrorOf(status: number, data: ErrorBody): ApiError {
  const code = data.error?.code ?? 'request_failed';
  const details = Array.isArray(data.error?.details) ? (data.error.details as ApiIssue[]) : [];
  const fieldIssues =
    code === 'validation_failed' ? details.filter((i) => Array.isArray(i.path)) : [];
  const message =
    fieldIssues.length > 0
      ? summarizeIssues(fieldIssues)
      : (data.error?.message ?? 'Request failed');
  return new ApiError(status, code, message, fieldIssues, data.error?.requestId);
}

type TokenProvider = () => Promise<string | null>;
let tokenProvider: TokenProvider = () => Promise.resolve(null);

/** The auth layer supplies the current access token; nothing here stores or caches it (BR-9). */
export function setTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

/** Authenticated call that returns the raw response: file downloads and multipart uploads. */
export async function rawRequest(
  method: string,
  path: string,
  body?: FormData,
  idempotencyKey?: string,
): Promise<Response> {
  const token = await tokenProvider();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    },
    ...(body === undefined ? {} : { body }),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as ErrorBody;
    throw apiErrorOf(response.status, data);
  }
  return response;
}

/**
 * `idempotencyKey` is fixed by the offline queue so a retried request is recognized by the server;
 * every other call gets a fresh key.
 */
export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<T> {
  const token = await tokenProvider();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'idempotency-key': idempotencyKey,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as ErrorBody;
  if (!response.ok) throw apiErrorOf(response.status, data);
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
