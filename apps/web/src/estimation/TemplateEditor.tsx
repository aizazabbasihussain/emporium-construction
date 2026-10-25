import { estimateLineKinds, estimateSuppliers, estimateWorkTypes } from '@emporium/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Input, Modal, Select, Space, Table } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { estimationApi, type Template, type TemplateLine, type TemplateParameter } from './api';
import { FormulaPreview } from './FormulaPreview';
import { useLineReferences } from './lists';

export interface TemplateEditorProps {
  open: boolean;
  /** The template to edit; without it a new template is created. */
  template?: Template | undefined;
  onClose: () => void;
}

const blankLine = (costCodeId: string): TemplateLine => ({
  description: '',
  lineKind: 'material',
  itemId: null,
  costCodeId,
  unitCode: 'nos',
  qtyFormula: '',
  defaultRate: null,
  suppliedBy: 'company',
});

/** Create or edit a template (BR-1, BR-2, BR-10). The API validates every rule again. */
export function TemplateEditor({ open, template, onClose }: TemplateEditorProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { costCodeOptions, unitOptions } = useLineReferences();
  const [code, setCode] = useState(template?.code ?? '');
  const [name, setName] = useState(template?.name ?? '');
  const [workType, setWorkType] = useState<string>(template?.workType ?? 'boundary_wall');
  const [active, setActive] = useState(template?.active ?? true);
  const [parameters, setParameters] = useState<TemplateParameter[]>(template?.parameters ?? []);
  const [lines, setLines] = useState<TemplateLine[]>(template?.lines ?? []);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = { code, name, workType, active, parameters, lines };
      return template === undefined
        ? estimationApi.createTemplate(body)
        : estimationApi.updateTemplate(template.id, { ...body, version: template.version });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['estimation'] });
      setError(null);
      onClose();
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? t(`estimation.errors.${cause.code}`, { defaultValue: cause.message })
          : t('common.saveError'),
      ),
  });

  const changeLine = (index: number, patch: Partial<TemplateLine>) =>
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  const changeParameter = (index: number, patch: Partial<TemplateParameter>) =>
    setParameters(parameters.map((p, i) => (i === index ? { ...p, ...patch } : p)));

  return (
    <Modal
      open={open}
      width={1100}
      title={template === undefined ? t('estimation.template.new') : t('estimation.template.edit')}
      onCancel={onClose}
      onOk={() => save.mutate()}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={save.isPending}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {error !== null && <Alert type="error" message={error} />}
        <Space wrap>
          <Input
            aria-label={t('estimation.template.code')}
            placeholder={t('estimation.template.code')}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <Input
            aria-label={t('estimation.template.name')}
            placeholder={t('estimation.template.name')}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Select
            aria-label={t('estimation.workType.label')}
            style={{ width: 200 }}
            value={workType}
            onChange={setWorkType}
            options={estimateWorkTypes.map((value) => ({
              value,
              label: t(`estimation.workType.${value}`),
            }))}
          />
          <Checkbox checked={active} onChange={(event) => setActive(event.target.checked)}>
            {t('estimation.template.active')}
          </Checkbox>
        </Space>

        <Table<TemplateParameter>
          size="small"
          rowKey={(_, index) => String(index)}
          pagination={false}
          dataSource={parameters}
          title={() => t('estimation.template.parameters')}
          columns={[
            {
              title: t('estimation.template.paramKey'),
              render: (_, p, index) => (
                <Input
                  aria-label={t('estimation.template.paramKey')}
                  value={p.key}
                  onChange={(event) => changeParameter(index, { key: event.target.value })}
                />
              ),
            },
            {
              title: t('estimation.template.paramLabel'),
              render: (_, p, index) => (
                <Input
                  aria-label={t('estimation.template.paramLabel')}
                  value={p.label}
                  onChange={(event) => changeParameter(index, { label: event.target.value })}
                />
              ),
            },
            {
              title: t('estimation.template.paramUnit'),
              render: (_, p, index) => (
                <Input
                  aria-label={t('estimation.template.paramUnit')}
                  value={p.unit}
                  onChange={(event) => changeParameter(index, { unit: event.target.value })}
                />
              ),
            },
            {
              render: (_, __, index) => (
                <Button onClick={() => setParameters(parameters.filter((_p, i) => i !== index))}>
                  {t('estimation.remove')}
                </Button>
              ),
            },
          ]}
          footer={() => (
            <Button
              onClick={() => setParameters([...parameters, { key: '', label: '', unit: '' }])}
            >
              {t('estimation.template.addParameter')}
            </Button>
          )}
        />

        <Table<TemplateLine>
          size="small"
          rowKey={(_, index) => String(index)}
          pagination={false}
          dataSource={lines}
          title={() => t('estimation.template.lines')}
          columns={[
            {
              title: t('estimation.line.description'),
              render: (_, line, index) => (
                <Input
                  aria-label={t('estimation.line.description')}
                  value={line.description}
                  onChange={(event) => changeLine(index, { description: event.target.value })}
                />
              ),
            },
            {
              title: t('estimation.line.kind'),
              render: (_, line, index) => (
                <Select
                  aria-label={t('estimation.line.kind')}
                  style={{ width: 150 }}
                  value={line.lineKind}
                  onChange={(value) => changeLine(index, { lineKind: value })}
                  options={estimateLineKinds.map((value) => ({
                    value,
                    label: t(`estimation.lineKind.${value}`),
                  }))}
                />
              ),
            },
            {
              title: t('estimation.line.costCode'),
              render: (_, line, index) => (
                <Select
                  aria-label={t('estimation.line.costCode')}
                  style={{ width: 180 }}
                  value={line.costCodeId || undefined}
                  onChange={(value) => changeLine(index, { costCodeId: value })}
                  options={costCodeOptions}
                />
              ),
            },
            {
              title: t('estimation.line.unit'),
              render: (_, line, index) => (
                <Select
                  aria-label={t('estimation.line.unit')}
                  style={{ width: 90 }}
                  value={line.unitCode}
                  onChange={(value) => changeLine(index, { unitCode: value })}
                  options={unitOptions}
                />
              ),
            },
            {
              title: t('estimation.line.formula'),
              render: (_, line, index) => (
                <Input
                  aria-label={t('estimation.line.formula')}
                  value={line.qtyFormula}
                  onChange={(event) => changeLine(index, { qtyFormula: event.target.value })}
                />
              ),
            },
            {
              title: t('estimation.line.defaultRate'),
              render: (_, line, index) => (
                <Input
                  aria-label={t('estimation.line.defaultRate')}
                  style={{ width: 110 }}
                  value={line.defaultRate ?? ''}
                  onChange={(event) =>
                    changeLine(index, {
                      defaultRate: event.target.value === '' ? null : event.target.value,
                    })
                  }
                />
              ),
            },
            {
              title: t('estimation.line.suppliedBy'),
              render: (_, line, index) => (
                <Select
                  aria-label={t('estimation.line.suppliedBy')}
                  style={{ width: 110 }}
                  value={line.suppliedBy}
                  onChange={(value) => changeLine(index, { suppliedBy: value })}
                  options={estimateSuppliers.map((value) => ({
                    value,
                    label: t(`estimation.supplier.${value}`),
                  }))}
                />
              ),
            },
            {
              render: (_, __, index) => (
                <Button onClick={() => setLines(lines.filter((_l, i) => i !== index))}>
                  {t('estimation.remove')}
                </Button>
              ),
            },
          ]}
          footer={() => (
            <Button
              onClick={() => setLines([...lines, blankLine(costCodeOptions[0]?.value ?? '')])}
            >
              {t('estimation.template.addLine')}
            </Button>
          )}
        />

        <FormulaPreview
          parameters={parameters}
          formulas={lines.map((line) => line.qtyFormula).filter((formula) => formula !== '')}
        />
      </Space>
    </Modal>
  );
}
