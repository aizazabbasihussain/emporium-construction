import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import { useAuth, type SignInResult } from '../auth/AuthProvider';

const messageKey: Record<Exclude<SignInResult, 'ok'>, string> = {
  bad_credentials: 'login.badCredentials',
  no_account: 'login.noAccount',
  error: 'login.error',
};

export function LoginPage() {
  const { t } = useTranslation();
  const { status, signIn } = useAuth();
  const [failure, setFailure] = useState<Exclude<SignInResult, 'ok'> | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'signedIn') return <Navigate to="/" replace />;

  const submit = async (values: { email: string; password: string }) => {
    setBusy(true);
    const result = await signIn(values.email.trim(), values.password);
    setBusy(false);
    setFailure(result === 'ok' ? null : result);
  };

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <Card style={{ width: 360 }}>
        <Typography.Title level={3}>{t('login.title')}</Typography.Title>
        <Form
          layout="vertical"
          onFinish={(values: { email: string; password: string }) => void submit(values)}
        >
          <Form.Item
            name="email"
            label={t('login.email')}
            rules={[
              { required: true, message: t('common.required') },
              {
                type: 'email',
                transform: (value: string) => value.trim(),
                message: t('login.emailInvalid'),
              },
            ]}
          >
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item
            name="password"
            label={t('login.password')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          {failure !== null && <Alert type="error" message={t(messageKey[failure])} />}
          <Button htmlType="submit" type="primary" block loading={busy}>
            {t('login.submit')}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
