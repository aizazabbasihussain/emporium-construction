import {
  expenseClaimEntityType,
  expensesPermissions as perm,
  formatAmount,
  formatDate,
} from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Descriptions, Input, Modal, Space, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useLineReferences } from '../estimation/lists';
import { AttachmentUploader } from '../files/AttachmentUploader';
import { filesApi } from '../files/api';
import { projectsApi } from '../projects/api';
import { expensesApi, type Claim } from './api';
import {
  ClaimLinesGrid,
  draftOf,
  emptyLine,
  lineOf,
  linesProblem,
  type LineDraft,
} from './ClaimLinesGrid';
import { useErrorText } from './shared';

function ReverseDialog({
  error,
  busy,
  onCancel,
  onConfirm,
}: {
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  return (
    <Modal
      open
      title={t('expenses.reverse.title')}
      okText={t('expenses.reverse.confirm')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      onCancel={onCancel}
      onOk={() => {
        if (reason.trim() === '') {
          setMissing(true);
          return;
        }
        onConfirm(reason.trim());
      }}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {missing && <Alert type="error" message={t('expenses.reverse.incomplete')} />}
        {error !== null && <Alert type="error" message={error} />}
        <Input.TextArea
          aria-label={t('expenses.reverse.reason')}
          placeholder={t('expenses.reverse.reason')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Space>
    </Modal>
  );
}

/** The form for a new claim (`claim` is undefined) or for one that exists. */
function ClaimForm({ claim }: { claim: Claim | undefined }) {
  const { t } = useTranslation();
  const { can, profile } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const references = useLineReferences();
  const today = new Date().toISOString().slice(0, 10);
  const [note, setNote] = useState(claim?.note ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    claim === undefined ? [emptyLine(today)] : claim.lines.map(draftOf),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [reversing, setReversing] = useState(false);

  useEffect(() => {
    if (claim === undefined) return;
    setNote(claim.note);
    setLines(claim.lines.map(draftOf));
  }, [claim]);

  const categories = useQuery({
    queryKey: ['expense-categories'],
    queryFn: expensesApi.categories,
  });
  const projects = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => projectsApi.list({ limit: 200 }),
  });
  const receipts = useQuery({
    queryKey: ['files', expenseClaimEntityType, claim?.id],
    queryFn: () => filesApi.list(expenseClaimEntityType, claim?.id as string),
    enabled: claim !== undefined,
  });

  const mine = claim === undefined || claim.claimantId === profile?.id;
  const editable = mine && (claim === undefined || ['draft', 'returned'].includes(claim.status));
  const fail = (cause: unknown) => {
    setSaved(false);
    setError(errorText(cause));
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['expense-claims'] });
  const body = () => ({ note: note.trim(), lines: lines.map(lineOf) });

  const save = useMutation({
    mutationFn: () =>
      claim === undefined
        ? expensesApi.createClaim(body())
        : expensesApi.updateClaim(claim.id, claim.version, body()),
    onSuccess: async (next) => {
      setError(null);
      setSaved(true);
      await refresh();
      if (claim === undefined) void navigate(`/expenses/claims/${next.id}`);
    },
    onError: fail,
  });

  const step = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: async () => {
      setError(null);
      setSaved(false);
      setReversing(false);
      setAcknowledge(false);
      await refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: () => expensesApi.removeClaim((claim as Claim).id, (claim as Claim).version),
    onSuccess: async () => {
      await refresh();
      void navigate('/expenses/claims');
    },
    onError: fail,
  });

  const problem = linesProblem(lines);
  const canSave = editable && can(perm.claimCreate) && problem === null;
  const status = claim?.status;
  const receiptOptions = (receipts.data?.items ?? []).map((a) => ({
    value: a.id,
    label: a.caption ?? a.fileName,
  }));
  const approval = claim?.approval;

  return (
    <div>
      <Link to="/expenses/claims">{t('expenses.claims.back')}</Link>
      <Typography.Title level={3}>
        {claim?.number ?? t('expenses.claims.new')}{' '}
        {status !== undefined && <Tag>{t(`expenses.status.${status}`)}</Tag>}
      </Typography.Title>
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      {saved && <Alert type="success" message={t('common.saved')} style={{ marginBottom: 12 }} />}
      {claim !== undefined && (
        <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
          <Descriptions.Item label={t('expenses.field.total')}>
            {formatAmount(claim.total)}
          </Descriptions.Item>
          {claim.submittedOn !== null && (
            <Descriptions.Item label={t('expenses.field.submittedOn')}>
              {formatDate(claim.submittedOn)}
            </Descriptions.Item>
          )}
          {approval !== undefined && (
            <Descriptions.Item label={t('expenses.field.approval')}>
              {approval.status === 'pending'
                ? t('expenses.approval.pending', { role: approval.currentRole })
                : t(`expenses.approval.${approval.status}`, { defaultValue: approval.status })}
            </Descriptions.Item>
          )}
          {claim.cancelReason !== null && (
            <Descriptions.Item label={t('expenses.field.cancelReason')}>
              {claim.cancelReason}
            </Descriptions.Item>
          )}
        </Descriptions>
      )}

      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Input.TextArea
          aria-label={t('expenses.field.note')}
          placeholder={t('expenses.field.note')}
          rows={2}
          disabled={!editable}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <ClaimLinesGrid
          lines={lines}
          categories={categories.data ?? []}
          costCodeOptions={references.costCodeOptions}
          projectOptions={(projects.data?.items ?? []).map((p) => ({
            value: p.id,
            label: `${p.code} ${p.name}`,
          }))}
          receiptOptions={receiptOptions}
          readOnly={!editable}
          onChange={setLines}
        />
        {problem !== null && editable && (
          <Alert type="warning" message={t(`expenses.lines.${problem}`)} />
        )}

        {claim !== undefined && claim.duplicates.length > 0 && (
          <Alert
            type="warning"
            message={t('expenses.duplicates.title')}
            description={
              <div>
                {claim.duplicates.map((d) => (
                  <div key={d.lineNo}>
                    {t('expenses.duplicates.line', {
                      line: d.lineNo,
                      match: d.matchedLineNo,
                      claim: d.matchedClaimNumber ?? t('expenses.duplicates.sameClaim'),
                    })}
                  </div>
                ))}
                {editable && (
                  <Checkbox
                    checked={acknowledge}
                    onChange={(event) => setAcknowledge(event.target.checked)}
                  >
                    {t('expenses.action.acknowledge')}
                  </Checkbox>
                )}
              </div>
            }
          />
        )}

        <Space wrap>
          {editable && can(perm.claimCreate) && (
            <Button
              type="primary"
              disabled={!canSave}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('expenses.action.save')}
            </Button>
          )}
          {claim !== undefined && editable && can(perm.claimCreate) && (
            <Button
              disabled={!canSave}
              loading={step.isPending}
              onClick={() =>
                step.mutate(() => expensesApi.submit(claim.id, claim.version, acknowledge))
              }
            >
              {t('expenses.action.submit')}
            </Button>
          )}
          {claim !== undefined && status === 'approved' && can(perm.claimPost) && (
            <Button
              type="primary"
              loading={step.isPending}
              onClick={() => step.mutate(() => expensesApi.post(claim.id, claim.version))}
            >
              {t('expenses.action.post')}
            </Button>
          )}
          {claim !== undefined &&
            status !== undefined &&
            ['draft', 'submitted', 'returned', 'approved'].includes(status) &&
            (mine || can(perm.claimReverse)) && (
              <Button
                danger
                loading={step.isPending}
                onClick={() => step.mutate(() => expensesApi.cancel(claim.id, claim.version))}
              >
                {t('expenses.action.cancel')}
              </Button>
            )}
          {claim !== undefined && status === 'posted' && can(perm.claimReverse) && (
            <Button danger onClick={() => setReversing(true)}>
              {t('expenses.action.reverse')}
            </Button>
          )}
          {claim !== undefined && status === 'draft' && mine && (
            <Button danger loading={remove.isPending} onClick={() => remove.mutate()}>
              {t('expenses.action.delete')}
            </Button>
          )}
        </Space>

        <Typography.Title level={5}>{t('expenses.receipts.title')}</Typography.Title>
        {claim === undefined ? (
          <Typography.Text type="secondary">{t('expenses.receipts.hint')}</Typography.Text>
        ) : (
          <AttachmentUploader entityType={expenseClaimEntityType} entityId={claim.id} />
        )}
      </Space>

      {reversing && claim !== undefined && (
        <ReverseDialog
          error={error}
          busy={step.isPending}
          onCancel={() => setReversing(false)}
          onConfirm={(reason) =>
            step.mutate(() => expensesApi.reverse(claim.id, claim.version, reason))
          }
        />
      )}
    </div>
  );
}

export function ClaimPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const claim = useQuery({
    queryKey: ['expense-claims', 'one', id],
    queryFn: () => expensesApi.claim(id as string),
    enabled: id !== undefined && id !== 'new',
  });
  if (id === 'new') return <ClaimForm claim={undefined} />;
  if (claim.isError) return <Alert type="error" message={t('common.loadError')} />;
  if (claim.data === undefined) return null;
  return <ClaimForm claim={claim.data} />;
}
