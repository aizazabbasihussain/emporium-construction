import { workerportalPermissions as perm, WORKER_ROLE } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Space, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { identityApi } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { workerPortalApi } from './api';
import { useErrorText } from './form';

/** The admin's control on the worker profile that links or removes the worker's login (BR-1). */
export function WorkerAccountControl({ workerId }: { workerId: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [userId, setUserId] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const allowed = can(perm.accountManage);

  const account = useQuery({
    queryKey: ['worker-account', workerId],
    queryFn: () => workerPortalApi.account(workerId),
    enabled: allowed,
  });
  const users = useQuery({
    queryKey: ['worker-account-users'],
    queryFn: identityApi.users,
    enabled: allowed,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['worker-account', workerId] });
  const link = useMutation({
    mutationFn: () => workerPortalApi.link(workerId, userId, confirm),
    onSuccess: async () => {
      setError(null);
      setMessage(t('workerportal.account.saved'));
      setUserId('');
      setConfirm(false);
      await refresh();
    },
    onError: (cause) => {
      setMessage(null);
      setError(errorText(cause));
    },
  });
  const unlink = useMutation({
    mutationFn: () => workerPortalApi.unlink(workerId),
    onSuccess: async () => {
      setError(null);
      setMessage(t('workerportal.account.removed'));
      await refresh();
    },
    onError: (cause) => {
      setMessage(null);
      setError(errorText(cause));
    },
  });

  if (!allowed) return null;
  const linked = account.data?.account ?? null;
  const linkedUser = users.data?.items.find((user) => user.id === linked?.userId);
  const chosen = users.data?.items.find((user) => user.id === userId);
  const otherRoles =
    chosen !== undefined && !(chosen.roles.length === 1 && chosen.roles[0] === WORKER_ROLE);

  return (
    <section aria-label={t('workerportal.account.title')} style={{ marginTop: 16 }}>
      <Typography.Title level={4}>{t('workerportal.account.title')}</Typography.Title>
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      {message !== null && <Alert type="success" message={message} style={{ marginBottom: 12 }} />}
      <Typography.Paragraph>
        {linked === null
          ? t('workerportal.account.none')
          : t('workerportal.account.linked', {
              name:
                linkedUser === undefined
                  ? linked.userId
                  : `${linkedUser.fullName} (${linkedUser.email})`,
            })}
      </Typography.Paragraph>
      <Space wrap>
        <select
          aria-label={t('workerportal.account.user')}
          style={{ minWidth: 220, padding: '4px 6px' }}
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
        >
          <option value="">{t('workerportal.account.pickUser')}</option>
          {(users.data?.items ?? []).map((user) => (
            <option key={user.id} value={user.id}>
              {user.fullName} ({user.email})
            </option>
          ))}
        </select>
        {otherRoles && (
          <Checkbox checked={confirm} onChange={(event) => setConfirm(event.target.checked)}>
            {t('workerportal.account.confirmOtherRoles')}
          </Checkbox>
        )}
        <Button
          type="primary"
          disabled={userId === '' || (otherRoles && !confirm)}
          loading={link.isPending}
          onClick={() => link.mutate()}
        >
          {t('workerportal.account.link')}
        </Button>
        {linked !== null && (
          <Button danger loading={unlink.isPending} onClick={() => unlink.mutate()}>
            {t('workerportal.account.unlink')}
          </Button>
        )}
      </Space>
    </section>
  );
}
