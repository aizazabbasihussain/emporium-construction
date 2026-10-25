import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Input, List, Space, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { estimationApi, type FormulaResult, type TemplateParameter } from './api';

export interface FormulaPreviewProps {
  parameters: TemplateParameter[];
  formulas: string[];
}

/**
 * Shows the quantity each formula gives for sample parameter values. The API evaluates the
 * formulas; nothing is calculated in the browser (constitution 3.5).
 */
export function FormulaPreview({ parameters, formulas }: FormulaPreviewProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [results, setResults] = useState<FormulaResult[] | null>(null);
  const run = useMutation({
    mutationFn: () => estimationApi.previewFormulas({ parameters, values, formulas }),
    onSuccess: (data) => setResults(data.results),
  });

  return (
    <div>
      <Typography.Title level={5}>{t('estimation.preview.title')}</Typography.Title>
      <Space wrap style={{ marginBottom: 8 }}>
        {parameters.map((parameter) => (
          <Input
            key={parameter.key}
            addonBefore={parameter.label || parameter.key}
            addonAfter={parameter.unit}
            aria-label={t('estimation.preview.sample', { name: parameter.label || parameter.key })}
            style={{ width: 220 }}
            value={values[parameter.key] ?? ''}
            onChange={(event) => setValues({ ...values, [parameter.key]: event.target.value })}
          />
        ))}
        <Button loading={run.isPending} onClick={() => run.mutate()}>
          {t('estimation.preview.run')}
        </Button>
      </Space>
      {run.isError && <Alert type="error" message={t('estimation.preview.failed')} />}
      {results !== null && (
        <List
          size="small"
          bordered
          dataSource={results}
          renderItem={(result) => (
            <List.Item>
              <code>{result.formula}</code>
              {result.ok ? (
                <strong>{` = ${result.quantity ?? ''}`}</strong>
              ) : (
                <Typography.Text type="danger">
                  {' '}
                  {t(`estimation.errors.${result.errorCode ?? 'unknown'}`, {
                    defaultValue: result.errorCode ?? '',
                  })}
                </Typography.Text>
              )}
            </List.Item>
          )}
        />
      )}
    </div>
  );
}
