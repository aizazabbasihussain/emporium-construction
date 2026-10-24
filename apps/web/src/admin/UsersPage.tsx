import { scopeTypes } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { identityApi, type ScopeGrant, type UserItem } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { ApiError } from './api';

type Editing = { kind: 'roles' | 'scopes'; user: UserItem } | { kind: 'add' } | null;

/** Maps an API error to a message the user can act on. */
function useErrorText() {
  const { t } = useTranslation();
  return (error: unknown): string => {
    if (error instanceof ApiError) {
      if (error.status === 409 && error.code === 'version_conflict') return t('common.conflict');
      const key = `admin.users.errors.${error.code}`;
      if (
        ['email_taken', 'cannot_remove_own_admin', 'cannot_disable_self', 'last_admin'].includes(
          error.code,
        )
      ) {
        return t(key);
      }
    }
    return t('common.saveError');
  };
}

export function UsersPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [editing, setEditing] = useState<Editing>(null);
  const manage = can('identity.user.manage');

  const users = useQuery({ queryKey: ['users'], queryFn: () => identityApi.users() });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => identityApi.roles() });

  const done = () => {
    setEditing(null);
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };
  const create = useMutation({ mutationFn: identityApi.createUser, onSuccess: done });
  const saveRoles = useMutation({
    mutationFn: (v: { user: UserItem; roles: string[] }) =>
      identityApi.setRoles(v.user.id, v.roles, v.user.version),
    onSuccess: done,
  });
  const saveScopes = useMutation({
    mutationFn: (v: { user: UserItem; scopes: ScopeGrant[] }) =>
      identityApi.setScopes(v.user.id, v.scopes, v.user.version),
    onSuccess: done,
  });
  const setStatus = useMutation({
    mutationFn: (v: { user: UserItem; status: 'active' | 'disabled' }) =>
      identityApi.setStatus(v.user.id, v.status, v.user.version),
    onSuccess: done,
  });

  const roleOptions = (roles.data?.items ?? []).map((r) => ({ value: r.code, label: r.name }));
  const roleName = (code: string) => roles.data?.items.find((r) => r.code === code)?.name ?? code;
  const failure = [create, saveRoles, saveScopes, setStatus].find((m) => m.isError)?.error;

  return (
    <div>
      <Typography.Title level={3}>{t('admin.users.title')}</Typography.Title>
      <Typography.Paragraph type="secondary">{t('admin.users.hint')}</Typography.Paragraph>
      {manage && (
        <Button type="primary" onClick={() => setEditing({ kind: 'add' })}>
          {t('admin.users.add')}
        </Button>
      )}
      {users.isError && <Alert type="error" message={t('common.loadError')} />}
      {failure !== undefined && <Alert type="error" message={errorText(failure)} />}
      <Table<UserItem>
        rowKey="id"
        loading={users.isLoading}
        dataSource={users.data?.items ?? []}
        pagination={false}
        columns={[
          { title: t('admin.users.fullName'), dataIndex: 'fullName' },
          { title: t('admin.users.email'), dataIndex: 'email' },
          {
            title: t('admin.users.status'),
            render: (_, u) => (
              <Tag color={u.status === 'active' ? 'green' : 'red'}>
                {t(`admin.users.statuses.${u.status}`)}
              </Tag>
            ),
          },
          {
            title: t('admin.users.roles'),
            render: (_, u) => u.roles.map((code) => <Tag key={code}>{roleName(code)}</Tag>),
          },
          {
            title: t('admin.users.scopes'),
            render: (_, u) => u.scopes.length,
          },
          ...(manage
            ? [
                {
                  title: '',
                  render: (_: unknown, u: UserItem) => (
                    <Space>
                      <Button size="small" onClick={() => setEditing({ kind: 'roles', user: u })}>
                        {t('admin.users.editRoles')} {u.email}
                      </Button>
                      <Button size="small" onClick={() => setEditing({ kind: 'scopes', user: u })}>
                        {t('admin.users.editScopes')} {u.email}
                      </Button>
                      {u.status === 'active' ? (
                        <Popconfirm
                          title={t('admin.users.disableConfirm')}
                          okText={t('common.yes')}
                          cancelText={t('common.no')}
                          onConfirm={() => setStatus.mutate({ user: u, status: 'disabled' })}
                        >
                          <Button size="small" danger>
                            {t('admin.users.disable')} {u.email}
                          </Button>
                        </Popconfirm>
                      ) : (
                        <Button
                          size="small"
                          onClick={() => setStatus.mutate({ user: u, status: 'active' })}
                        >
                          {t('admin.users.enable')} {u.email}
                        </Button>
                      )}
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />

      <Modal
        open={editing?.kind === 'add'}
        title={t('admin.users.add')}
        footer={null}
        destroyOnHidden
        onCancel={() => setEditing(null)}
      >
        <Form
          layout="vertical"
          onFinish={(v: { email: string; fullName: string; phone?: string; roles?: string[] }) =>
            create.mutate({
              email: v.email.trim(),
              fullName: v.fullName.trim(),
              ...(v.phone?.trim() ? { phone: v.phone.trim() } : {}),
              roles: v.roles ?? [],
            })
          }
        >
          <Form.Item
            name="email"
            label={t('admin.users.email')}
            rules={[
              { required: true, message: t('common.required') },
              {
                type: 'email',
                transform: (value: string) => value.trim(),
                message: t('admin.users.emailInvalid'),
              },
            ]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="fullName"
            label={t('admin.users.fullName')}
            rules={[{ required: true, whitespace: true, message: t('common.required') }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="phone" label={t('admin.users.phone')}>
            <Input />
          </Form.Item>
          <Form.Item name="roles" label={t('admin.users.roles')}>
            <Select mode="multiple" options={roleOptions} />
          </Form.Item>
          <Button htmlType="submit" type="primary" loading={create.isPending}>
            {t('common.save')}
          </Button>
        </Form>
      </Modal>

      <Modal
        open={editing?.kind === 'roles'}
        title={t('admin.users.editRoles')}
        footer={null}
        destroyOnHidden
        onCancel={() => setEditing(null)}
      >
        {editing?.kind === 'roles' && (
          <Form
            layout="vertical"
            initialValues={{ roles: editing.user.roles }}
            onFinish={(v: { roles: string[] }) =>
              saveRoles.mutate({ user: editing.user, roles: v.roles })
            }
          >
            <Form.Item name="roles" label={t('admin.users.roles')}>
              <Select mode="multiple" options={roleOptions} />
            </Form.Item>
            <Button htmlType="submit" type="primary" loading={saveRoles.isPending}>
              {t('common.save')}
            </Button>
          </Form>
        )}
      </Modal>

      <Modal
        open={editing?.kind === 'scopes'}
        title={t('admin.users.editScopes')}
        footer={null}
        destroyOnHidden
        onCancel={() => setEditing(null)}
      >
        {editing?.kind === 'scopes' && (
          <Form
            layout="vertical"
            initialValues={{ scopes: editing.user.scopes }}
            onFinish={(v: { scopes?: ScopeGrant[] }) =>
              saveScopes.mutate({ user: editing.user, scopes: v.scopes ?? [] })
            }
          >
            <Typography.Paragraph type="secondary">
              {t('admin.users.scopeHint')}
            </Typography.Paragraph>
            <Form.List name="scopes">
              {(fields, { add, remove }) => (
                <>
                  {fields.map((field) => (
                    <Space key={field.key} align="start">
                      <Form.Item name={[field.name, 'type']} rules={[{ required: true }]}>
                        <Select
                          aria-label={t('admin.users.scopeType')}
                          style={{ width: 120 }}
                          options={scopeTypes.map((type) => ({
                            value: type,
                            label: t(`admin.users.scopeTypes.${type}`),
                          }))}
                        />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, 'id']}
                        rules={[
                          {
                            required: true,
                            pattern:
                              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
                            message: t('admin.users.scopeIdInvalid'),
                          },
                        ]}
                      >
                        <Input aria-label={t('admin.users.scopeId')} style={{ width: 300 }} />
                      </Form.Item>
                      <Button onClick={() => remove(field.name)}>-</Button>
                    </Space>
                  ))}
                  <Form.Item>
                    <Button onClick={() => add({ type: 'project', id: '' })}>
                      {t('admin.users.scopeAdd')}
                    </Button>
                  </Form.Item>
                </>
              )}
            </Form.List>
            <Button htmlType="submit" type="primary" loading={saveScopes.isPending}>
              {t('common.save')}
            </Button>
          </Form>
        )}
      </Modal>
    </div>
  );
}
