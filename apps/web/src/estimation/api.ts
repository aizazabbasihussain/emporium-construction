import type {
  EstimateLineKind,
  EstimateSector,
  EstimateSupplier,
  EstimateWorkType,
} from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface TemplateParameter {
  key: string;
  label: string;
  unit: string;
}

export interface TemplateLine {
  lineNo?: number;
  description: string;
  lineKind: EstimateLineKind;
  itemId: string | null;
  costCodeId: string;
  unitCode: string;
  qtyFormula: string;
  defaultRate: string | null;
  suppliedBy: EstimateSupplier;
}

export interface TemplateSummary {
  id: string;
  code: string;
  name: string;
  workType: EstimateWorkType;
  active: boolean;
  version: number;
}

export interface Template extends TemplateSummary {
  parameters: TemplateParameter[];
  lines: TemplateLine[];
}

export interface FormulaResult {
  formula: string;
  ok: boolean;
  quantity: string | null;
  errorCode: string | null;
}

export interface EstimateLine {
  lineNo?: number;
  description: string;
  lineKind: EstimateLineKind;
  itemId: string | null;
  costCodeId: string;
  unitCode: string;
  quantity: string;
  rate: string;
  suppliedBy: EstimateSupplier;
  note: string | null;
  lineTotal?: string;
  rateMissing?: boolean;
}

export interface EstimateHeader {
  id: string;
  number: string;
  revision: number;
  leadId: string | null;
  partyId: string | null;
  templateId: string | null;
  title: string;
  workType: EstimateWorkType;
  sector: EstimateSector;
  status: 'draft' | 'locked' | 'superseded';
  parentEstimateId: string | null;
  parameterValues: Record<string, string>;
  overheadPercent: string;
  contingencyPercent: string;
  targetMarginPercent: string;
  proposedPrice: string | null;
  lockedAt: string | null;
  version: number;
}

export interface Estimate extends EstimateHeader {
  lines: EstimateLine[];
}

export interface Totals {
  companyCost: string;
  clientSuppliedValue: string;
  overheadAmount: string;
  contingencyAmount: string;
  totalCost: string;
  proposedPrice: string | null;
  expectedMargin: string | null;
  marginPercent: string | null;
  targetMarginPercent: string;
  meetsTarget: boolean | null;
}

export interface Preview {
  totals: Totals;
  rateMissingCount: number;
}

export interface Terms {
  overheadPercent: string;
  contingencyPercent: string;
  targetMarginPercent: string;
  proposedPrice: string | null;
}

export type Params = Record<string, string | number | boolean | undefined>;

const query = (params: Params): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
};

export const estimationApi = {
  templates: (params: Params = {}) =>
    request<Page<TemplateSummary>>('GET', `/estimation/templates?${query(params)}`),
  template: (id: string) => request<Template>('GET', `/estimation/templates/${id}`),
  createTemplate: (body: unknown) => request<Template>('POST', '/estimation/templates', body),
  updateTemplate: (id: string, body: unknown) =>
    request<Template>('PUT', `/estimation/templates/${id}`, body),
  previewFormulas: (body: {
    parameters: TemplateParameter[];
    values: Record<string, string>;
    formulas: string[];
  }) => request<{ results: FormulaResult[] }>('POST', '/estimation/formula-preview', body),
  estimates: (params: Params = {}) =>
    request<Page<EstimateHeader>>('GET', `/estimation/estimates?${query(params)}`),
  estimate: (id: string) => request<Estimate>('GET', `/estimation/estimates/${id}`),
  fromTemplate: (body: unknown) =>
    request<Estimate>('POST', '/estimation/estimates/from-template', body),
  updateEstimate: (id: string, body: unknown) =>
    request<Estimate>('PUT', `/estimation/estimates/${id}`, body),
  preview: (
    body: {
      lines: Pick<EstimateLine, 'lineKind' | 'quantity' | 'rate' | 'suppliedBy'>[];
    } & Partial<Terms>,
  ) => request<Preview>('POST', '/estimation/estimates/preview', body),
  lock: (id: string, version: number) =>
    request<Estimate>('POST', `/estimation/estimates/${id}/lock`, { version }),
  revise: (id: string) => request<Estimate>('POST', `/estimation/estimates/${id}/revise`, {}),
};
