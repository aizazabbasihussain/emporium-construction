import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Modal, Select } from 'antd';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import type { Authority } from './api';
import { firstProblem, type RuleFields } from './form';

/**
 * The shared shell of the three "request a rule" dialogs: it checks the fields, sends the request
 * and shows what the API answers. The owner still has to approve the request (BR-6).
 */
export function RuleDialog<T>(props: {
  open: boolean;
  title: string;
  fields: RuleFields;
  send: () => Promise<T>;
  onClose: () => void;
  onSent: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: props.send,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['tax'] });
      setError(null);
      props.onSent();
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? t(`tax.errors.${cause.code}`, { defaultValue: cause.message })
          : t('common.saveError'),
      ),
  });

  const submit = () => {
    const problem = firstProblem(props.fields);
    if (problem !== null) setError(t(`tax.errors.${problem}`));
    else mutation.mutate();
  };

  return (
    <Modal
      open={props.open}
      title={props.title}
      onCancel={props.onClose}
      footer={null}
      destroyOnHidden
    >
      <Form layout="vertical">
        {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
        {props.children}
        <Button type="primary" loading={mutation.isPending} onClick={submit}>
          {t('tax.dialog.submit')}
        </Button>
      </Form>
    </Modal>
  );
}

export function AuthoritySelect(props: {
  authorities: Authority[];
  value: string | undefined;
  onChange: (code: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Form.Item label={t('tax.fields.authority')}>
      <Select
        aria-label={t('tax.fields.authority')}
        value={props.value}
        onChange={props.onChange}
        options={props.authorities.map((authority) => ({
          value: authority.code,
          label: `${authority.code} - ${authority.name}`,
        }))}
      />
    </Form.Item>
  );
}

export function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'date';
}) {
  return (
    <Form.Item label={props.label}>
      <Input
        aria-label={props.label}
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </Form.Item>
  );
}

export function EnumSelect<V extends string>(props: {
  label: string;
  value: V | undefined;
  values: readonly V[];
  labelOf: (value: V) => string;
  onChange: (value: V) => void;
}) {
  return (
    <Form.Item label={props.label}>
      <Select
        aria-label={props.label}
        value={props.value}
        onChange={props.onChange}
        options={props.values.map((value) => ({ value, label: props.labelOf(value) }))}
      />
    </Form.Item>
  );
}
