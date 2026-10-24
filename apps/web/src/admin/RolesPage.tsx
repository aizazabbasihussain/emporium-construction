import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Select, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { identityApi, type RoleItem } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

export function RolesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const manage = can('identity.role.manage');
  // Unsaved edits per role; a role without an entry shows its saved permissions.
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});

  const roles = useQuery({ queryKey: ['roles'], queryFn: () => identityApi.roles() });
  const save = useMutation({
    mutationFn: (v: { code: string; permissions: string[] }) =>
      identityApi.setRolePermissions(v.code, v.permissions),
    onSuccess: (_data, v) => {
      setDrafts(({ [v.code]: _saved, ...rest }) => rest);
      void queryClient.invalidateQueries({ queryKey: ['roles'] });
    },
  });

  const options = (roles.data?.permissions ?? []).map((code) => ({ value: code, label: code }));

  return (
    <div>
      <Typography.Title level={3}>{t('admin.roles.title')}</Typography.Title>
      <Typography.Paragraph type="secondary">{t('admin.roles.hint')}</Typography.Paragraph>
      {roles.isError && <Alert type="error" message={t('common.loadError')} />}
      {save.isError && <Alert type="error" message={t('common.saveError')} />}
      <Table<RoleItem>
        rowKey="code"
        loading={roles.isLoading}
        dataSource={roles.data?.items ?? []}
        pagination={false}
        columns={[
          { title: t('admin.roles.role'), dataIndex: 'name' },
          {
            title: t('admin.roles.permissions'),
            render: (_, role) => (
              <Select
                mode="multiple"
                disabled={!manage}
                aria-label={`${t('admin.roles.permissions')} ${role.name}`}
                style={{ minWidth: 360 }}
                options={options}
                value={drafts[role.code] ?? role.permissions}
                onChange={(value: string[]) => setDrafts((d) => ({ ...d, [role.code]: value }))}
              />
            ),
          },
          ...(manage
            ? [
                {
                  title: '',
                  render: (_: unknown, role: RoleItem) => (
                    <Button
                      type="primary"
                      size="small"
                      disabled={drafts[role.code] === undefined}
                      loading={save.isPending && save.variables?.code === role.code}
                      onClick={() =>
                        save.mutate({ code: role.code, permissions: drafts[role.code] ?? [] })
                      }
                    >
                      {t('common.save')} {role.name}
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}
