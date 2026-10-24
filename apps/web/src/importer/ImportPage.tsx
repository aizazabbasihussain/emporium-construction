import { importerPermissions } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Select, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { importApi, type BatchItem, type DryRunResult, type ImportError } from './api';

export function ImportPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [code, setCode] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [force, setForce] = useState(false);
  const [result, setResult] = useState<DryRunResult | null>(null);
  const [committedRows, setCommittedRows] = useState<number | null>(null);
  const [fileMissing, setFileMissing] = useState(false);

  const canRun = can(importerPermissions.batchRun);
  const canForce = can(importerPermissions.batchForce);
  const importers = useQuery({ queryKey: ['importers'], queryFn: () => importApi.importers() });
  const batches = useQuery({ queryKey: ['import-batches'], queryFn: () => importApi.batches() });
  const chosen = importers.data?.items.find((i) => i.code === code);

  const dryRun = useMutation({
    mutationFn: (upload: File) => importApi.dryRun(code as string, upload),
    onSuccess: async (data) => {
      setResult(data);
      setCommittedRows(null);
      await queryClient.invalidateQueries({ queryKey: ['import-batches'] });
    },
  });
  const commit = useMutation({
    mutationFn: () => importApi.commit((result as DryRunResult).batchId, force),
    onSuccess: async (batch) => {
      setCommittedRows(batch.rowCount);
      setResult(null);
      await queryClient.invalidateQueries({ queryKey: ['import-batches'] });
    },
  });

  const failure = (error: unknown): string => {
    if (!(error instanceof ApiError)) return t('common.saveError');
    return t(`imports.errors.${error.code}`, { defaultValue: error.message });
  };

  const submit = () => {
    if (file === null) {
      setFileMissing(true);
      return;
    }
    setFileMissing(false);
    dryRun.mutate(file);
  };

  return (
    <div>
      <Typography.Title level={3}>{t('imports.title')}</Typography.Title>
      <Typography.Paragraph type="secondary">{t('imports.hint')}</Typography.Paragraph>
      {importers.isError && <Alert type="error" message={t('common.loadError')} />}

      {canRun && (
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <label>
            {t('imports.importer')}
            <Select
              aria-label={t('imports.importer')}
              style={{ width: 320, display: 'block' }}
              placeholder={t('imports.choose')}
              value={code}
              onChange={(value) => {
                setCode(value);
                setResult(null);
                setCommittedRows(null);
              }}
              options={(importers.data?.items ?? []).map((i) => ({
                value: i.code,
                label: i.label,
              }))}
            />
          </label>
          {chosen && chosen.dependsOn.length > 0 && (
            <Alert
              type="info"
              message={t('imports.dependsOn', { codes: chosen.dependsOn.join(', ') })}
            />
          )}
          {chosen && (
            <>
              <Space>
                {(['csv', 'xlsx'] as const).map((format) => (
                  <Button
                    key={format}
                    onClick={() =>
                      void importApi.download(
                        `/imports/importers/${chosen.code}/template?format=${format}`,
                        `${chosen.code}-template.${format}`,
                      )
                    }
                  >
                    {t(format === 'csv' ? 'imports.templateCsv' : 'imports.templateXlsx')}
                  </Button>
                ))}
              </Space>
              <label>
                {t('imports.file')}
                <input
                  type="file"
                  accept=".csv,.xlsx"
                  style={{ display: 'block' }}
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    setResult(null);
                  }}
                />
              </label>
              {fileMissing && <Alert type="warning" message={t('imports.fileRequired')} />}
              <Button type="primary" loading={dryRun.isPending} onClick={submit}>
                {t('imports.dryRun')}
              </Button>
            </>
          )}
          {dryRun.isError && <Alert type="error" message={failure(dryRun.error)} />}
          {result && <DryRunPanel result={result} />}
          {result?.status === 'dry_run_ok' && (
            <Space direction="vertical">
              {canForce && (
                <Checkbox checked={force} onChange={(event) => setForce(event.target.checked)}>
                  {t('imports.force')}
                </Checkbox>
              )}
              <Button type="primary" loading={commit.isPending} onClick={() => commit.mutate()}>
                {t('imports.commit')}
              </Button>
            </Space>
          )}
          {commit.isError && <Alert type="error" message={failure(commit.error)} />}
          {committedRows !== null && (
            <Alert type="success" message={t('imports.committed', { rows: committedRows })} />
          )}
        </Space>
      )}

      <Typography.Title level={4}>{t('imports.history')}</Typography.Title>
      {batches.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<BatchItem>
        rowKey="id"
        size="small"
        loading={batches.isLoading}
        dataSource={batches.data?.items ?? []}
        pagination={false}
        columns={[
          { title: t('imports.historyColumns.importer'), dataIndex: 'importerCode' },
          { title: t('imports.historyColumns.file'), dataIndex: 'fileName' },
          {
            title: t('imports.historyColumns.status'),
            render: (_, b) => t(`imports.statuses.${b.status}`),
          },
          { title: t('imports.historyColumns.rows'), dataIndex: 'rowCount' },
          { title: t('imports.historyColumns.errors'), dataIndex: 'errorCount' },
          {
            title: '',
            render: (_, b) =>
              b.errorCount > 0 && (
                <Button
                  size="small"
                  onClick={() =>
                    void importApi.download(`/imports/batches/${b.id}/errors.csv`, 'errors.csv')
                  }
                >
                  {t('imports.errorReport')} {b.fileName}
                </Button>
              ),
          },
        ]}
      />
    </div>
  );
}

function DryRunPanel({ result }: { result: DryRunResult }) {
  const { t } = useTranslation();
  const ok = result.status === 'dry_run_ok';
  return (
    <div>
      <Alert
        type={ok ? 'success' : 'error'}
        message={
          ok
            ? t('imports.resultOk', { rows: result.rowCount })
            : t('imports.resultFailed', { errors: result.errorCount })
        }
      />
      {!ok && (
        <>
          {result.errorCount > result.errors.length && (
            <Typography.Paragraph type="secondary">
              {t('imports.moreErrors', { shown: result.errors.length, total: result.errorCount })}
            </Typography.Paragraph>
          )}
          <Table<ImportError>
            rowKey={(e) => `${e.rowNo}-${e.column}-${e.message}`}
            size="small"
            pagination={{ pageSize: 20 }}
            dataSource={result.errors}
            columns={[
              { title: t('imports.errorColumns.row'), dataIndex: 'rowNo' },
              { title: t('imports.errorColumns.column'), dataIndex: 'column' },
              { title: t('imports.errorColumns.message'), dataIndex: 'message' },
            ]}
          />
          <Button
            onClick={() =>
              void importApi.download(`/imports/batches/${result.batchId}/errors.csv`, 'errors.csv')
            }
          >
            {t('imports.errorReport')}
          </Button>
        </>
      )}
    </div>
  );
}
