import type { ProfitabilityAlertCode, ThresholdScope } from '@emporium/shared';
import { rawRequest, request } from '../admin/api';

export interface PortfolioRow {
  projectId: string;
  code: string;
  name: string;
  status: string;
  contractValue: string;
  billedPercent: string | null;
  collectedPercent: string | null;
  costPercentOfBudget: string | null;
  expectedMargin: string;
  expectedMarginPercent: string | null;
  cashPosition: string;
  alerts: ProfitabilityAlertCode[];
}

export interface Portfolio {
  asOf: string;
  items: PortfolioRow[];
}

export interface Forecast {
  id: string;
  projectId: string;
  costToComplete: string;
  note: string;
  forecastDate: string;
  setBy: string;
}

export interface Threshold {
  id: string;
  scope: ThresholdScope;
  projectId: string | null;
  marginFloorPercent: string;
  overspendPercent: string;
  receivableAgeDays: number;
  active: boolean;
  version: number;
}

export interface ProjectFinancials {
  projectId: string;
  code: string;
  name: string;
  status: string;
  asOf: string;
  contractValue: string;
  billedBase: string;
  billedTax: string;
  billedGross: string;
  billedPercent: string | null;
  collectedGross: string;
  collectedBase: string;
  withheldTax: string;
  collectedPercent: string | null;
  outstandingReceivable: string;
  committed: string;
  approved: string;
  posted: string;
  costToDate: string;
  budget: string;
  costPercentOfBudget: string | null;
  costToComplete: string;
  costToCompleteSource: 'forecast' | 'budget';
  expectedMargin: string;
  expectedMarginPercent: string | null;
  currentMargin: string;
  currentMarginPercent: string | null;
  paidOutVendors: string;
  paidOutWages: string;
  paidOutExpenses: string;
  paidOut: string;
  cashPosition: string;
  forecast: Forecast | null;
  thresholds: Threshold | null;
  alerts: ProfitabilityAlertCode[];
  oldestDueDate: string | null;
}

export interface Alert {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  alertCode: ProfitabilityAlertCode;
  raisedAt: string;
  clearedAt: string | null;
}

export interface ThresholdBody {
  marginFloorPercent: string;
  overspendPercent: string;
  receivableAgeDays: number;
  active?: boolean;
}

const query = (params: Record<string, string | boolean | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
};

export const profitabilityApi = {
  portfolio: (params: { asOf?: string | undefined; status?: string | undefined }) =>
    request<Portfolio>('GET', `/profitability/projects${query(params)}`),
  project: (id: string, asOf?: string) =>
    request<ProjectFinancials>('GET', `/profitability/projects/${id}${query({ asOf })}`),
  setForecast: (
    id: string,
    body: { costToComplete: string; note?: string; forecastDate?: string },
  ) => request<Forecast>('PUT', `/profitability/projects/${id}/forecast`, body),
  alerts: (onlyOpen: boolean) =>
    request<Alert[]>('GET', `/profitability/alerts${query({ onlyOpen: onlyOpen || undefined })}`),
  thresholds: () => request<Threshold[]>('GET', '/profitability/thresholds'),
  createThreshold: (body: ThresholdBody) =>
    request<Threshold>('POST', '/profitability/thresholds', { scope: 'company', ...body }),
  updateThreshold: (threshold: Threshold, body: ThresholdBody) =>
    request<Threshold>('PUT', `/profitability/thresholds/${threshold.id}`, {
      ...body,
      version: threshold.version,
    }),
  removeThreshold: (threshold: Threshold) =>
    request<{ id: string }>(
      'DELETE',
      `/profitability/thresholds/${threshold.id}?version=${threshold.version}`,
    ),
  /** Fetches the export with the access token and hands it to the browser as a download. */
  download: async (
    target: {
      projectId?: string | undefined;
      asOf?: string | undefined;
      status?: string | undefined;
    },
    format: 'csv' | 'xlsx',
  ): Promise<void> => {
    const path =
      target.projectId === undefined
        ? `/profitability/projects${query({ asOf: target.asOf, status: target.status, format })}`
        : `/profitability/projects/${target.projectId}${query({ asOf: target.asOf, format })}`;
    const blob = await (await rawRequest('GET', path)).blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `profitability.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  },
};
