import { attendancePermissions as perm, entryStatuses, formatAmount } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { projectsApi } from '../projects/api';
import { attendanceApi, type Sheet } from './api';
import {
  isWorked,
  karachiToday,
  rowProblem,
  rowsFromGrid,
  sheetBody,
  useErrorText,
  type RowDraft,
} from './form';

const selectStyle = { minWidth: 120, padding: '4px 6px' } as const;

/**
 * The attendance grid of one team and date: a row per worker with a status, the project split of
 * the day, overtime and remarks. Saving sends the whole grid at once (BR-10); the API checks it.
 */
export function GridPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [params, setParams] = useSearchParams();
  const teamId = params.get('team') ?? '';
  const date = params.get('date') ?? karachiToday();
  const valid = teamId !== '' && /^\d{4}-\d{2}-\d{2}$/.test(date);

  const [rows, setRows] = useState<RowDraft[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [reason, setReason] = useState('');

  const teams = useQuery({ queryKey: ['attendance-teams'], queryFn: attendanceApi.teams });
  const projects = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => projectsApi.list({ limit: 200 }),
  });
  const grid = useQuery({
    queryKey: ['attendance-grid', teamId, date],
    queryFn: () => attendanceApi.grid(teamId, date),
    enabled: valid,
  });
  const projectOptions = (projects.data?.items ?? []).filter((p) => p.status === 'active');
  const defaultProject = projectOptions.length === 1 ? (projectOptions[0]?.id ?? '') : '';

  useEffect(() => {
    if (grid.data !== undefined) {
      setRows(rowsFromGrid(grid.data, defaultProject));
      setDirty(false);
    }
  }, [grid.data, defaultProject]);

  const sheet: Sheet | null = grid.data?.sheet ?? null;
  const locked = sheet?.status === 'submitted' || sheet?.status === 'approved';
  const mayWrite = can(perm.sheetCreate) || can(perm.sheetUpdate);
  const readOnly = locked || !mayWrite;
  const problem = rows.map((row) => ({ row, problem: rowProblem(row) })).find((x) => x.problem);

  const edit = (index: number, change: Partial<RowDraft>) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...change } : row)));
    setDirty(true);
  };

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['attendance-grid', teamId, date] });

  const fail = (cause: unknown) => {
    setMessage(null);
    setError(errorText(cause));
  };

  const save = useMutation({
    mutationFn: () => attendanceApi.save(teamId, date, sheetBody(rows, sheet?.version)),
    onSuccess: async () => {
      setError(null);
      setMessage(t('attendance.grid.saved'));
      await refresh();
    },
    onError: fail,
  });

  const submit = useMutation({
    mutationFn: async () => {
      const current =
        dirty || sheet === null
          ? await attendanceApi.save(teamId, date, sheetBody(rows, sheet?.version))
          : sheet;
      return attendanceApi.submit(current.id, current.version);
    },
    onSuccess: async () => {
      setError(null);
      setMessage(t('attendance.grid.submitted'));
      await refresh();
    },
    onError: fail,
  });

  const unlock = useMutation({
    mutationFn: () => attendanceApi.unlock((sheet as Sheet).id, (sheet as Sheet).version, reason),
    onSuccess: async () => {
      setError(null);
      setUnlocking(false);
      setReason('');
      setMessage(t('attendance.grid.unlocked'));
      await refresh();
    },
    onError: fail,
  });

  const nameOf = (id: string): string => {
    const found = projectOptions.find((p) => p.id === id);
    return found === undefined ? id : `${found.code} ${found.name}`;
  };

  const projectSelect = (label: string, value: string, onChange: (v: string) => void) => (
    <select
      aria-label={label}
      style={selectStyle}
      value={value}
      disabled={readOnly}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{t('attendance.column.project')}</option>
      {projectOptions.map((p) => (
        <option key={p.id} value={p.id}>
          {nameOf(p.id)}
        </option>
      ))}
    </select>
  );

  return (
    <div>
      <Typography.Title level={3}>{t('attendance.grid.title')}</Typography.Title>
      <Space style={{ marginBottom: 12 }} wrap>
        <select
          aria-label={t('attendance.grid.team')}
          style={selectStyle}
          value={teamId}
          onChange={(event) => setParams({ team: event.target.value, date })}
        >
          <option value="">{t('attendance.grid.pickTeam')}</option>
          {(teams.data ?? [])
            .filter((team) => team.active)
            .map((team) => (
              <option key={team.id} value={team.id}>
                {team.code} {team.name}
              </option>
            ))}
        </select>
        <Input
          type="date"
          aria-label={t('attendance.grid.date')}
          value={date}
          onChange={(event) => setParams({ team: teamId, date: event.target.value })}
        />
        {sheet !== null && <Tag>{t(`attendance.sheetStatus.${sheet.status}`)}</Tag>}
        {sheet?.total != null && (
          <Typography.Text>
            {t('attendance.grid.total')}: {formatAmount(sheet.total)}
          </Typography.Text>
        )}
      </Space>
      {(teams.isError || grid.isError) && (
        <Alert type="error" message={t('common.loadError')} style={{ marginBottom: 12 }} />
      )}
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      {message !== null && <Alert type="success" message={message} style={{ marginBottom: 12 }} />}
      {sheet?.status === 'rejected' && (
        <Alert
          type="warning"
          style={{ marginBottom: 12 }}
          message={t('attendance.grid.rejectedHint')}
          description={sheet.approval.lastComment}
        />
      )}
      {locked && (
        <Alert type="info" style={{ marginBottom: 12 }} message={t('attendance.grid.lockedHint')} />
      )}
      {problem !== undefined && !readOnly && (
        <Alert
          type="warning"
          style={{ marginBottom: 12 }}
          message={t(`attendance.problem.${problem.problem}`, { worker: problem.row.fullName })}
        />
      )}
      {valid && grid.data?.members.length === 0 && sheet === null && (
        <Typography.Paragraph>{t('attendance.grid.noMembers')}</Typography.Paragraph>
      )}
      {rows.length > 0 && (
        <Table<RowDraft>
          size="small"
          pagination={false}
          rowKey="workerId"
          dataSource={rows}
          scroll={{ x: true }}
          columns={[
            {
              title: t('attendance.column.worker'),
              render: (_, row) => `${row.code} ${row.fullName}`,
            },
            {
              title: t('attendance.column.status'),
              render: (_, row, index) => (
                <select
                  aria-label={`${t('attendance.column.status')} ${row.code}`}
                  style={selectStyle}
                  value={row.status}
                  disabled={readOnly}
                  onChange={(event) => {
                    const status = event.target.value as RowDraft['status'];
                    edit(index, {
                      status,
                      ...(isWorked(status) && row.splits.length === 0
                        ? { splits: [{ projectId: defaultProject, percent: '100' }] }
                        : {}),
                    });
                  }}
                >
                  {entryStatuses.map((status) => (
                    <option key={status} value={status}>
                      {t(`attendance.status.${status}`)}
                    </option>
                  ))}
                </select>
              ),
            },
            {
              title: t('attendance.column.projects'),
              render: (_, row, index) =>
                isWorked(row.status) ? (
                  <Space direction="vertical" size={4}>
                    {row.splits.map((split, at) => (
                      <Space key={at} size={4}>
                        {projectSelect(
                          `${t('attendance.column.project')} ${row.code} ${at + 1}`,
                          split.projectId,
                          (projectId) =>
                            edit(index, {
                              splits: row.splits.map((s, i) =>
                                i === at ? { ...s, projectId } : s,
                              ),
                            }),
                        )}
                        <Input
                          style={{ width: 80 }}
                          aria-label={`${t('attendance.column.share')} ${row.code} ${at + 1}`}
                          value={split.percent}
                          disabled={readOnly}
                          onChange={(event) =>
                            edit(index, {
                              splits: row.splits.map((s, i) =>
                                i === at ? { ...s, percent: event.target.value } : s,
                              ),
                            })
                          }
                        />
                        {row.splits.length > 1 && !readOnly && (
                          <Button
                            size="small"
                            aria-label={`${t('attendance.grid.removeSplit')} ${row.code} ${at + 1}`}
                            onClick={() =>
                              edit(index, { splits: row.splits.filter((_s, i) => i !== at) })
                            }
                          >
                            ×
                          </Button>
                        )}
                      </Space>
                    ))}
                    {!readOnly && (
                      <Button
                        size="small"
                        onClick={() =>
                          edit(index, {
                            splits: [...row.splits, { projectId: '', percent: '' }],
                          })
                        }
                      >
                        {t('attendance.grid.addSplit')}
                        <span hidden>{row.code}</span>
                      </Button>
                    )}
                  </Space>
                ) : null,
            },
            {
              title: t('attendance.column.overtime'),
              render: (_, row, index) =>
                isWorked(row.status) ? (
                  <Input
                    style={{ width: 80 }}
                    aria-label={`${t('attendance.column.overtime')} ${row.code}`}
                    value={row.overtime}
                    disabled={readOnly}
                    onChange={(event) => edit(index, { overtime: event.target.value })}
                  />
                ) : null,
            },
            {
              title: t('attendance.column.remarks'),
              render: (_, row, index) => (
                <Input
                  aria-label={`${t('attendance.column.remarks')} ${row.code}`}
                  value={row.remarks}
                  disabled={readOnly}
                  onChange={(event) => edit(index, { remarks: event.target.value })}
                />
              ),
            },
          ]}
        />
      )}
      <Space style={{ marginTop: 12 }} wrap>
        {!readOnly && rows.length > 0 && (
          <Button
            onClick={() => {
              setRows((current) =>
                current.map((row) => ({
                  ...row,
                  status: 'present',
                  splits:
                    row.splits.length > 0
                      ? row.splits
                      : [{ projectId: defaultProject, percent: '100' }],
                })),
              );
              setDirty(true);
            }}
          >
            {t('attendance.grid.allPresent')}
          </Button>
        )}
        {!readOnly && rows.length > 0 && (
          <Button
            loading={save.isPending}
            disabled={problem !== undefined}
            onClick={() => save.mutate()}
          >
            {t('attendance.grid.save')}
          </Button>
        )}
        {!readOnly && rows.length > 0 && (
          <Button
            type="primary"
            loading={submit.isPending}
            disabled={problem !== undefined}
            onClick={() => submit.mutate()}
          >
            {t('attendance.grid.submit')}
          </Button>
        )}
        {sheet?.status === 'approved' && can(perm.sheetUnlock) && (
          <Button danger onClick={() => setUnlocking(true)}>
            {t('attendance.grid.unlock')}
          </Button>
        )}
      </Space>
      {unlocking && (
        <Modal
          open
          title={t('attendance.grid.unlock')}
          okText={t('attendance.grid.unlock')}
          cancelText={t('common.cancel')}
          okButtonProps={{ disabled: reason.trim() === '', loading: unlock.isPending }}
          onOk={() => unlock.mutate()}
          onCancel={() => setUnlocking(false)}
        >
          <Input.TextArea
            aria-label={t('attendance.grid.unlockReason')}
            placeholder={t('attendance.grid.unlockReason')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Modal>
      )}
    </div>
  );
}
