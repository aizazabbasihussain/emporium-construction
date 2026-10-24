import { rawRequest, request } from '../admin/api';

export interface ImporterItem {
  code: string;
  label: string;
  dependsOn: string[];
}

export interface BatchItem {
  id: string;
  importerCode: string;
  fileName: string;
  status: 'dry_run_ok' | 'dry_run_failed' | 'committed' | 'rolled_back';
  rowCount: number;
  errorCount: number;
  dryRunAt: string | null;
}

export interface ImportError {
  rowNo: number;
  column: string;
  message: string;
}

export interface DryRunResult {
  batchId: string;
  status: BatchItem['status'];
  rowCount: number;
  errorCount: number;
  errors: ImportError[];
}

export const importApi = {
  importers: () => request<{ items: ImporterItem[] }>('GET', '/imports/importers'),
  batches: () => request<{ items: BatchItem[] }>('GET', '/imports/batches?limit=20'),
  dryRun: async (code: string, file: File): Promise<DryRunResult> => {
    const form = new FormData();
    form.append('file', file, file.name);
    const response = await rawRequest('POST', `/imports/importers/${code}/dry-run`, form);
    return (await response.json()) as DryRunResult;
  },
  commit: (batchId: string, force: boolean) =>
    request<BatchItem>('POST', `/imports/batches/${batchId}/commit`, { force }),
  /** Fetches a file with the access token and hands it to the browser as a download. */
  download: async (path: string, fileName: string): Promise<void> => {
    const blob = await (await rawRequest('GET', path)).blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  },
};
