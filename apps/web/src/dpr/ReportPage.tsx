import {
  dprPermissions as perm,
  dprReportEntityType,
  dprWeathers,
  formatDate,
  submittedConflict,
} from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Input, Select, Space, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { AttachmentUploader } from '../files/AttachmentUploader';
import { DraftBanner } from '../offline/DraftBanner';
import { useOffline, type SubmitResult } from '../offline/OfflineProvider';
import { QueuedPhotos } from '../offline/QueuedPhotos';
import { useDraft } from '../offline/useDraft';
import { projectsApi } from '../projects/api';
import { dprApi, type Report } from './api';
import {
  bodyOf,
  draftOf,
  emptyDraft,
  karachiToday,
  saveProblem,
  submitProblem,
  useErrorText,
  type ReportDraft,
} from './form';

function ReportForm({ report }: { report: Report | undefined }) {
  const { t } = useTranslation();
  const { can, profile } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [draft, setDraft] = useState<ReportDraft>(
    report === undefined ? emptyDraft(karachiToday()) : draftOf(report),
  );
  const [reviewNote, setReviewNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const offline = useOffline();
  // BR-2: the form is kept on the device as it is typed; only a user's own change starts saving.
  const slot = useDraft<ReportDraft>('dpr', report === undefined ? 'new' : report.id);
  const [touched, setTouched] = useState(false);
  const [photoRound, setPhotoRound] = useState(0);
  const saveSlot = slot.save;

  useEffect(() => {
    if (report !== undefined) setDraft(draftOf(report));
  }, [report]);

  useEffect(() => {
    if (touched) saveSlot(draft);
  }, [draft, touched, saveSlot]);

  const projects = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => projectsApi.list({ limit: 200 }),
  });
  const tasks = useQuery({
    queryKey: ['project-tasks', draft.projectId],
    queryFn: () => projectsApi.tasks(draft.projectId),
    enabled: draft.projectId !== '',
  });

  const isNew = report === undefined;
  const mine = isNew || report.authorId === profile?.id;
  const editable = mine && (isNew || ['draft', 'reopened'].includes(report.status));
  const canReview = !isNew && report.status === 'submitted' && can(perm.reportReview);

  const patch = (change: Partial<ReportDraft>) => {
    setTouched(true);
    setDraft((current) => ({ ...current, ...change }));
  };
  // BR-8: the server's submitted report wins; a draft for that date cannot replace it.
  const sameProject = useQuery({
    queryKey: ['dpr-reports', 'project', draft.projectId],
    queryFn: () => dprApi.reports({ projectId: draft.projectId }),
    enabled: isNew && draft.projectId !== '' && offline.online,
  });
  const conflict = isNew && submittedConflict(draft.reportDate, sameProject.data?.items ?? []);
  const fail = (cause: unknown) => {
    setMessage(null);
    setError(errorText(cause));
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['dpr-reports'] });

  /** BR-3: a new report goes through the retry queue, so a lost connection never loses it. */
  const afterQueued = async (result: SubmitResult) => {
    if (result.status === 'sent') {
      setError(null);
      setMessage(t('dpr.saved'));
      await slot.clear();
      await refresh();
      void navigate(`/dpr/reports/${result.item.resultId}`);
    } else if (result.status === 'queued') {
      setError(null);
      setMessage(t('offline.savedWillSend'));
      await slot.clear();
      setDraft(emptyDraft(karachiToday()));
      setTouched(false);
      setPhotoRound((round) => round + 1);
    } else {
      // BR-4: the server refused it; the form comes back as typed, with the reason.
      await offline.editAndResend(result.item);
      setPhotoRound((round) => round + 1);
      setMessage(null);
      setError(result.item.lastError ?? t('common.saveError'));
    }
  };

  const save = useMutation({
    mutationFn: async (): Promise<Report | SubmitResult> => {
      if (report !== undefined) return dprApi.update(report.id, report.version, bodyOf(draft));
      if (!offline.available) {
        return dprApi.create(draft.projectId, draft.reportDate, bodyOf(draft));
      }
      return offline.submit({
        method: 'POST',
        url: '/dpr/reports',
        body: { projectId: draft.projectId, reportDate: draft.reportDate, ...bodyOf(draft) },
        source: { formType: 'dpr', draftKey: slot.key, path: '/dpr/reports/new', payload: draft },
      });
    },
    onSuccess: async (next) => {
      if ('status' in next && 'item' in next) return afterQueued(next);
      setError(null);
      setMessage(t('dpr.saved'));
      await refresh();
      await slot.clear();
      setTouched(false);
      if (report === undefined) void navigate(`/dpr/reports/${next.id}`);
      else queryClient.setQueryData(['dpr-reports', 'one', next.id], next);
    },
    onError: fail,
  });

  const step = useMutation({
    mutationFn: async (run: { done: string; call: () => Promise<Report> }) => {
      const next = await run.call();
      return { next, done: run.done };
    },
    onSuccess: async ({ next, done }) => {
      setError(null);
      setMessage(t(done));
      setReviewNote('');
      queryClient.setQueryData(['dpr-reports', 'one', next.id], next);
      await refresh();
    },
    onError: fail,
  });

  const saveIssue = saveProblem(draft, isNew);
  const submitIssue = submitProblem(draft);
  const projectOptions = (projects.data?.items ?? []).map((p) => ({
    value: p.id,
    label: `${p.code} ${p.name}`,
  }));
  const taskOptions = (tasks.data ?? []).map((task) => ({
    value: task.id,
    label: `${task.name} (${t('dpr.tasks.current', { percent: task.percentComplete })})`,
  }));

  return (
    <div>
      <Link to="/dpr/reports">{t('dpr.back')}</Link>
      <Typography.Title level={3}>
        {isNew ? t('dpr.new') : formatDate(report.reportDate)}{' '}
        {!isNew && <Tag>{t(`dpr.status.${report.status}`)}</Tag>}
      </Typography.Title>
      {editable && (
        <DraftBanner
          draft={slot}
          onRestore={(restored) => {
            // A draft saved by an older version of the form still opens: missing fields are blank.
            setDraft({ ...emptyDraft(karachiToday()), ...restored });
            setTouched(true);
          }}
        />
      )}
      {conflict && (
        <Alert
          type="warning"
          showIcon
          message={t('offline.conflict')}
          style={{ marginBottom: 12 }}
        />
      )}
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      {message !== null && <Alert type="success" message={message} style={{ marginBottom: 12 }} />}
      {!isNew && report.reviewNote !== null && (
        <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
          <Descriptions.Item label={t('dpr.field.reviewNote')}>
            {report.reviewNote}
          </Descriptions.Item>
        </Descriptions>
      )}

      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Space wrap>
          <Select
            style={{ minWidth: 260 }}
            aria-label={t('dpr.field.project')}
            placeholder={t('dpr.form.chooseProject')}
            disabled={!isNew}
            value={draft.projectId === '' ? undefined : draft.projectId}
            options={projectOptions}
            onChange={(value: string) => patch({ projectId: value, tasks: [] })}
          />
          <Input
            type="date"
            aria-label={t('dpr.field.date')}
            disabled={!isNew}
            value={draft.reportDate}
            onChange={(event) => patch({ reportDate: event.target.value })}
          />
          <Select
            style={{ minWidth: 160 }}
            aria-label={t('dpr.field.weather')}
            disabled={!editable}
            value={draft.weather}
            options={dprWeathers.map((w) => ({ value: w, label: t(`dpr.weather.${w}`) }))}
            onChange={(value) => patch({ weather: value })}
          />
        </Space>

        <Input.TextArea
          aria-label={t('dpr.field.workDone')}
          placeholder={t('dpr.field.workDone')}
          rows={3}
          disabled={!editable}
          value={draft.workDone}
          onChange={(event) => patch({ workDone: event.target.value })}
        />
        <Input.TextArea
          aria-label={t('dpr.field.issues')}
          placeholder={t('dpr.field.issues')}
          rows={2}
          disabled={!editable}
          value={draft.issues}
          onChange={(event) => patch({ issues: event.target.value })}
        />
        <Input.TextArea
          aria-label={t('dpr.field.safetyNotes')}
          placeholder={t('dpr.field.safetyNotes')}
          rows={2}
          disabled={!editable}
          value={draft.safetyNotes}
          onChange={(event) => patch({ safetyNotes: event.target.value })}
        />

        <Typography.Title level={5}>{t('dpr.manpower.title')}</Typography.Title>
        {draft.manpower.map((row, index) => (
          <Space key={index} wrap>
            <Input
              aria-label={`${t('dpr.manpower.trade')} ${index + 1}`}
              placeholder={t('dpr.manpower.trade')}
              disabled={!editable}
              value={row.trade}
              onChange={(event) =>
                patch({
                  manpower: draft.manpower.map((m, i) =>
                    i === index ? { ...m, trade: event.target.value } : m,
                  ),
                })
              }
            />
            <Input
              aria-label={`${t('dpr.manpower.count')} ${index + 1}`}
              placeholder={t('dpr.manpower.count')}
              inputMode="numeric"
              disabled={!editable}
              value={row.count}
              onChange={(event) =>
                patch({
                  manpower: draft.manpower.map((m, i) =>
                    i === index ? { ...m, count: event.target.value } : m,
                  ),
                })
              }
            />
            {editable && (
              <Button
                onClick={() => patch({ manpower: draft.manpower.filter((_, i) => i !== index) })}
              >
                {t('dpr.manpower.remove')}
              </Button>
            )}
          </Space>
        ))}
        {editable && (
          <Button
            onClick={() => patch({ manpower: [...draft.manpower, { trade: '', count: '' }] })}
          >
            {t('dpr.manpower.add')}
          </Button>
        )}

        <Typography.Title level={5}>{t('dpr.tasks.title')}</Typography.Title>
        {draft.tasks.map((row, index) => (
          <Space key={index} wrap>
            <Select
              style={{ minWidth: 260 }}
              aria-label={`${t('dpr.tasks.task')} ${index + 1}`}
              placeholder={t('dpr.form.chooseTask')}
              disabled={!editable}
              value={row.taskId === '' ? undefined : row.taskId}
              options={taskOptions}
              onChange={(value: string) =>
                patch({
                  tasks: draft.tasks.map((x, i) => (i === index ? { ...x, taskId: value } : x)),
                })
              }
            />
            <Input
              aria-label={`${t('dpr.tasks.percent')} ${index + 1}`}
              placeholder={t('dpr.tasks.percent')}
              inputMode="numeric"
              disabled={!editable}
              value={row.percent}
              onChange={(event) =>
                patch({
                  tasks: draft.tasks.map((x, i) =>
                    i === index ? { ...x, percent: event.target.value } : x,
                  ),
                })
              }
            />
            <Input
              aria-label={`${t('dpr.tasks.note')} ${index + 1}`}
              placeholder={t('dpr.tasks.note')}
              disabled={!editable}
              value={row.note}
              onChange={(event) =>
                patch({
                  tasks: draft.tasks.map((x, i) =>
                    i === index ? { ...x, note: event.target.value } : x,
                  ),
                })
              }
            />
            {editable && (
              <Button onClick={() => patch({ tasks: draft.tasks.filter((_, i) => i !== index) })}>
                {t('dpr.tasks.remove')}
              </Button>
            )}
          </Space>
        ))}
        {editable && (
          <Button
            disabled={draft.projectId === ''}
            onClick={() =>
              patch({ tasks: [...draft.tasks, { taskId: '', percent: '', note: '' }] })
            }
          >
            {t('dpr.tasks.add')}
          </Button>
        )}

        <Typography.Title level={5}>{t('dpr.materials.title')}</Typography.Title>
        {draft.materials.map((row, index) => (
          <Space key={index} wrap>
            <Input
              aria-label={`${t('dpr.materials.description')} ${index + 1}`}
              placeholder={t('dpr.materials.description')}
              disabled={!editable}
              value={row.description}
              onChange={(event) =>
                patch({
                  materials: draft.materials.map((x, i) =>
                    i === index ? { ...x, description: event.target.value } : x,
                  ),
                })
              }
            />
            <Input
              aria-label={`${t('dpr.materials.quantity')} ${index + 1}`}
              placeholder={t('dpr.materials.quantity')}
              inputMode="decimal"
              disabled={!editable}
              value={row.quantity}
              onChange={(event) =>
                patch({
                  materials: draft.materials.map((x, i) =>
                    i === index ? { ...x, quantity: event.target.value } : x,
                  ),
                })
              }
            />
            <Input
              aria-label={`${t('dpr.materials.unit')} ${index + 1}`}
              placeholder={t('dpr.materials.unit')}
              disabled={!editable}
              value={row.unitCode}
              onChange={(event) =>
                patch({
                  materials: draft.materials.map((x, i) =>
                    i === index ? { ...x, unitCode: event.target.value } : x,
                  ),
                })
              }
            />
            {editable && (
              <Button
                onClick={() => patch({ materials: draft.materials.filter((_, i) => i !== index) })}
              >
                {t('dpr.materials.remove')}
              </Button>
            )}
          </Space>
        ))}
        {editable && (
          <Button
            onClick={() =>
              patch({
                materials: [...draft.materials, { description: '', quantity: '', unitCode: '' }],
              })
            }
          >
            {t('dpr.materials.add')}
          </Button>
        )}

        {saveIssue !== null && editable && (
          <Alert type="warning" message={t(`dpr.form.${saveIssue}`)} />
        )}
        {saveIssue === null && submitIssue !== null && editable && !isNew && (
          <Alert type="info" message={t(`dpr.form.${submitIssue}`)} />
        )}

        <Space wrap>
          {editable && can(isNew ? perm.reportCreate : perm.reportUpdateOwn) && (
            <Button
              type="primary"
              disabled={saveIssue !== null || conflict}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('dpr.action.save')}
            </Button>
          )}
          {!isNew && editable && can(perm.reportUpdateOwn) && (
            <Button
              disabled={saveIssue !== null || submitIssue !== null}
              loading={step.isPending}
              onClick={() =>
                step.mutate({
                  done: 'dpr.submitted',
                  call: async () => {
                    // Submit what is on screen: save the form first, then submit the new version.
                    const saved = await dprApi.update(report.id, report.version, bodyOf(draft));
                    return dprApi.submit(saved.id, saved.version);
                  },
                })
              }
            >
              {t('dpr.action.submit')}
            </Button>
          )}
        </Space>

        {canReview && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Input.TextArea
              aria-label={t('dpr.field.reviewNote')}
              placeholder={t('dpr.form.reviewNote')}
              rows={2}
              value={reviewNote}
              onChange={(event) => setReviewNote(event.target.value)}
            />
            <Space wrap>
              <Button
                type="primary"
                loading={step.isPending}
                onClick={() =>
                  step.mutate({
                    done: 'dpr.reviewed',
                    call: () => dprApi.review(report.id, report.version, reviewNote),
                  })
                }
              >
                {t('dpr.action.review')}
              </Button>
              <Button
                danger
                loading={step.isPending}
                onClick={() =>
                  step.mutate({
                    done: 'dpr.reopened',
                    call: () => dprApi.reopen(report.id, report.version, reviewNote),
                  })
                }
              >
                {t('dpr.action.reopen')}
              </Button>
            </Space>
          </Space>
        )}

        <Typography.Title level={5}>{t('dpr.photos.title')}</Typography.Title>
        {isNew && offline.available ? (
          <QueuedPhotos key={photoRound} draftKey={slot.key} />
        ) : isNew ? (
          <Typography.Text type="secondary">{t('dpr.photos.hint')}</Typography.Text>
        ) : (
          <AttachmentUploader entityType={dprReportEntityType} entityId={report.id} />
        )}
      </Space>
    </div>
  );
}

export function ReportPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const report = useQuery({
    queryKey: ['dpr-reports', 'one', id],
    queryFn: () => dprApi.report(id as string),
    enabled: id !== undefined && id !== 'new',
  });
  if (id === 'new') return <ReportForm report={undefined} />;
  if (report.isError) return <Alert type="error" message={t('common.loadError')} />;
  if (report.data === undefined) return null;
  return <ReportForm report={report.data} />;
}
