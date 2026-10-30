import {
  adjustmentKinds,
  formatAmount,
  formatDate,
  wagesPermissions as perm,
  type AdjustmentKind,
} from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { wagesApi, type Adjustment, type Line } from './api';
import { canAdjust, canCalculate, canSubmit, isAmount, monthKeys, useErrorText } from './form';

const selectStyle = { minWidth: 120, padding: '4px 6px' } as const;

/**
 * The wage sheet of one month: a row per worker with days, pay components and net pay, a panel of
 * warnings the approver acknowledges, a drill-down per worker with the manual adjustments, and
 * a print view. Every figure comes from the API.
 */
export function WageSheetPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const { id = '' } = useParams();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  const [adjusting, setAdjusting] = useState<Line | null>(null);
  const [kind, setKind] = useState<AdjustmentKind>('allowance');
  const [amount, setAmount] = useState('');
  const [why, setWhy] = useState('');

  const detail = useQuery({ queryKey: ['wage-period', id], queryFn: () => wagesApi.detail(id) });
  const sheet = useQuery({ queryKey: ['wage-lines', id], queryFn: () => wagesApi.lines(id) });
  const period = detail.data;
  const status = period?.status ?? 'draft';
  const warnings = period?.warnings;
  const needsAcknowledgement =
    (warnings?.missingSheets.length ?? 0) + (warnings?.shortfalls.length ?? 0) > 0;
  const blocked = (warnings?.unapprovedSheets.length ?? 0) > 0;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['wage-period', id] });
    await queryClient.invalidateQueries({ queryKey: ['wage-lines', id] });
    await queryClient.invalidateQueries({ queryKey: ['wage-periods'] });
  };
  const fail = (cause: unknown) => {
    setMessage(null);
    setError(errorText(cause));
  };
  const done = async (text: string) => {
    setError(null);
    setMessage(text);
    await refresh();
  };

  const calculate = useMutation({
    mutationFn: () => wagesApi.calculate(id),
    onSuccess: () => done(t('wages.sheet.calculated')),
    onError: fail,
  });
  const submit = useMutation({
    mutationFn: () => wagesApi.submit(id, (period as { version: number }).version, acknowledged),
    onSuccess: () => done(t('wages.sheet.submitted')),
    onError: fail,
  });
  const reopen = useMutation({
    mutationFn: () => wagesApi.reopen(id, (period as { version: number }).version, reason),
    onSuccess: async () => {
      setReopening(false);
      setReason('');
      await done(t('wages.sheet.reopened'));
    },
    onError: fail,
  });
  const adjust = useMutation({
    mutationFn: () =>
      wagesApi.adjust((adjusting as Line).id, { kind, amount: amount.trim(), reason: why }),
    onSuccess: async () => {
      setAdjusting(null);
      setAmount('');
      setWhy('');
      await done(t('wages.sheet.adjusted'));
    },
    onError: fail,
  });

  const lines = sheet.data?.lines ?? [];
  const adjustments = sheet.data?.adjustments ?? [];
  const money = (value: string) => formatAmount(value);

  return (
    <div>
      <style>{'@media print { .no-print { display: none !important; } }'}</style>
      <Typography.Title level={3}>
        {period === undefined
          ? t('wages.sheet.title')
          : `${t('wages.sheet.title')}: ${t(`wages.month.${monthKeys[period.month - 1] as string}`)} ${period.year}`}
      </Typography.Title>
      <Space style={{ marginBottom: 12 }} wrap>
        {period !== undefined && <Tag>{t(`wages.periodStatus.${status}`)}</Tag>}
        {period !== undefined && (
          <Typography.Text>
            {formatDate(period.from)} - {formatDate(period.to)}
          </Typography.Text>
        )}
        {period?.approval.lastComment != null && (
          <Typography.Text type="secondary">{period.approval.lastComment}</Typography.Text>
        )}
      </Space>
      <Space className="no-print" style={{ marginBottom: 12 }} wrap>
        {can(perm.periodCalculate) && canCalculate(status) && (
          <Button loading={calculate.isPending} onClick={() => calculate.mutate()}>
            {t('wages.sheet.calculate')}
          </Button>
        )}
        {can(perm.periodSubmit) && canSubmit(status) && (
          <Button
            type="primary"
            loading={submit.isPending}
            disabled={blocked || (needsAcknowledgement && !acknowledged) || lines.length === 0}
            onClick={() => submit.mutate()}
          >
            {t('wages.sheet.submit')}
          </Button>
        )}
        {can(perm.periodReopen) && status === 'approved' && (
          <Button danger onClick={() => setReopening(true)}>
            {t('wages.sheet.reopen')}
          </Button>
        )}
        <Button onClick={() => window.print()}>{t('wages.sheet.print')}</Button>
        <Link to={`/wages/periods/${id}/reconciliation`}>{t('wages.sheet.reconciliation')}</Link>
      </Space>
      {(detail.isError || sheet.isError) && (
        <Alert type="error" message={t('common.loadError')} style={{ marginBottom: 12 }} />
      )}
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      {message !== null && <Alert type="success" message={message} style={{ marginBottom: 12 }} />}
      {status === 'submitted' && (
        <Alert type="info" message={t('wages.sheet.withApprover')} style={{ marginBottom: 12 }} />
      )}
      {status === 'approved' && (
        <Alert type="info" message={t('wages.sheet.lockedHint')} style={{ marginBottom: 12 }} />
      )}
      {warnings !== undefined && (blocked || needsAcknowledgement) && (
        <Alert
          className="no-print"
          style={{ marginBottom: 12 }}
          type={blocked ? 'error' : 'warning'}
          message={t('wages.warnings.title')}
          description={
            <div>
              {warnings.unapprovedSheets.length > 0 && (
                <p>
                  {t('wages.warnings.unapproved', { count: warnings.unapprovedSheets.length })}{' '}
                  {warnings.unapprovedSheets.map((s) => formatDate(s.date)).join(', ')}
                </p>
              )}
              {warnings.missingSheets.length > 0 && (
                <p>{t('wages.warnings.missing', { count: warnings.missingSheets.length })}</p>
              )}
              {warnings.shortfalls.map((s) => (
                <p key={s.workerId}>
                  {t('wages.warnings.shortfall', {
                    worker: s.workerName,
                    amount: money(s.amount),
                  })}
                </p>
              ))}
              {!blocked && (
                <Checkbox
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                >
                  {t('wages.warnings.acknowledge')}
                </Checkbox>
              )}
            </div>
          }
        />
      )}
      <Table<Line>
        size="small"
        rowKey="id"
        pagination={false}
        scroll={{ x: true }}
        dataSource={lines}
        locale={{ emptyText: t('wages.sheet.empty') }}
        expandable={{
          expandedRowRender: (line) => (
            <Drilldown
              line={line}
              adjustments={adjustments.filter((a) => a.lineId === line.id)}
              mayAdjust={can(perm.adjustmentManage) && canAdjust(status)}
              onAdjust={() => {
                setKind('allowance');
                setAdjusting(line);
              }}
            />
          ),
        }}
        columns={[
          { title: t('wages.column.worker'), render: (_, l) => `${l.workerCode} ${l.workerName}` },
          { title: t('wages.column.basis'), render: (_, l) => t(`wages.basis.${l.payBasis}`) },
          { title: t('wages.column.rate'), render: (_, l) => money(l.rate) },
          { title: t('wages.column.present'), dataIndex: 'presentDays' },
          { title: t('wages.column.overtimeHours'), dataIndex: 'overtimeHours' },
          { title: t('wages.column.basic'), render: (_, l) => money(l.basicPay) },
          { title: t('wages.column.overtime'), render: (_, l) => money(l.overtimePay) },
          { title: t('wages.column.allowances'), render: (_, l) => money(l.allowances) },
          { title: t('wages.column.deductions'), render: (_, l) => money(l.deductions) },
          { title: t('wages.column.recovery'), render: (_, l) => money(l.advanceRecovery) },
          { title: t('wages.column.gross'), render: (_, l) => money(l.grossPay) },
          { title: t('wages.column.net'), render: (_, l) => <strong>{money(l.netPay)}</strong> },
        ]}
        summary={() =>
          sheet.data === undefined || lines.length === 0 ? null : (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={6}>
                <strong>{t('wages.sheet.totals')}</strong>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={6}>
                {money(sheet.data.totals.overtimePay)}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={7}>
                {money(sheet.data.totals.allowances)}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={8}>
                {money(sheet.data.totals.deductions)}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={9}>
                {money(sheet.data.totals.advanceRecovery)}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={10}>
                {money(sheet.data.totals.grossPay)}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={11}>
                <strong>{money(sheet.data.totals.netPay)}</strong>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          )
        }
      />

      <Modal
        open={reopening}
        title={t('wages.sheet.reopen')}
        okText={t('wages.sheet.reopen')}
        okButtonProps={{ disabled: reason.trim() === '', loading: reopen.isPending }}
        onOk={() => reopen.mutate()}
        onCancel={() => setReopening(false)}
      >
        <Input.TextArea
          aria-label={t('wages.sheet.reopenReason')}
          placeholder={t('wages.sheet.reopenReason')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Modal>

      <Modal
        open={adjusting !== null}
        title={t('wages.adjust.title', { worker: adjusting?.workerName ?? '' })}
        okText={t('wages.adjust.save')}
        okButtonProps={{
          disabled: !isAmount(amount) || why.trim() === '',
          loading: adjust.isPending,
        }}
        onOk={() => adjust.mutate()}
        onCancel={() => setAdjusting(null)}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <select
            aria-label={t('wages.adjust.kind')}
            style={selectStyle}
            value={kind}
            onChange={(event) => setKind(event.target.value as AdjustmentKind)}
          >
            {adjustmentKinds.map((value) => (
              <option key={value} value={value}>
                {t(`wages.adjust.${value}`)}
              </option>
            ))}
          </select>
          <Input
            aria-label={t('wages.adjust.amount')}
            placeholder={t('wages.adjust.amount')}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <Input.TextArea
            aria-label={t('wages.adjust.reason')}
            placeholder={t('wages.adjust.reason')}
            value={why}
            onChange={(event) => setWhy(event.target.value)}
          />
        </Space>
      </Modal>
    </div>
  );
}

/** The days, the rounding and the adjustments behind one worker's line. */
function Drilldown(props: {
  line: Line;
  adjustments: Adjustment[];
  mayAdjust: boolean;
  onAdjust: () => void;
}) {
  const { t } = useTranslation();
  const { line, adjustments, mayAdjust, onAdjust } = props;
  return (
    <div>
      <Typography.Paragraph>
        {t('wages.drilldown.days', {
          present: line.presentDays,
          half: line.halfDays,
          leave: line.paidLeaveDays,
          off: line.offDays,
          absent: line.absentDays,
        })}
      </Typography.Paragraph>
      <Typography.Paragraph>
        {t('wages.drilldown.rounding', { amount: formatAmount(line.roundingAdjustment) })}
      </Typography.Paragraph>
      {Number(line.shortfall) > 0 && (
        <Alert
          type="warning"
          message={t('wages.drilldown.shortfall', { amount: formatAmount(line.shortfall) })}
          style={{ marginBottom: 8 }}
        />
      )}
      {adjustments.length === 0 ? (
        <Typography.Paragraph type="secondary">{t('wages.drilldown.none')}</Typography.Paragraph>
      ) : (
        <ul>
          {adjustments.map((a) => (
            <li key={a.id}>
              {t(`wages.adjust.${a.kind}`)} {formatAmount(a.amount)}: {a.reason}
            </li>
          ))}
        </ul>
      )}
      {mayAdjust && (
        <Button className="no-print" size="small" onClick={onAdjust}>
          {t('wages.drilldown.add')}
        </Button>
      )}
    </div>
  );
}
