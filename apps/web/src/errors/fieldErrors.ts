import type { FormInstance } from 'antd';
import { useEffect } from 'react';
import { ApiError } from '../admin/api';
import { describeIssue } from './issues';

/** Problem sentence per field, keyed by the request path joined with dots ("lines.0.description"). */
export type FieldErrors = Readonly<Record<string, string>>;

const none: FieldErrors = {};

/** Field problems carried by a failed request; empty for any other kind of error. */
export function fieldErrorsOf(error: unknown): FieldErrors {
  if (!(error instanceof ApiError) || error.details.length === 0) return none;
  const result: Record<string, string> = {};
  for (const issue of error.details) {
    const key = (issue.path ?? []).join('.');
    if (key !== '' && result[key] === undefined) result[key] = describeIssue(issue);
  }
  return result;
}

/**
 * Props that turn an antd Input or Select red and tell screen readers why. Spread them on the
 * control: `<Input {...fieldProps(errors, 'lines', index, 'description')} />`.
 */
export function fieldProps(errors: FieldErrors, ...path: (string | number)[]) {
  const message = errors[path.join('.')];
  return message === undefined
    ? {}
    : { status: 'error' as const, 'aria-invalid': true, title: message };
}

/**
 * For screens built on antd `Form`: after a failed save, marks each rejected field red with its
 * problem sentence. Pass the mutation's `error`; fields the form does not have are ignored.
 */
export function useServerFieldErrors(form: FormInstance, error: unknown): void {
  useEffect(() => {
    const errors = fieldErrorsOf(error);
    const fields = Object.entries(errors).map(([key, message]) => ({
      name: key.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
      errors: [message],
    }));
    if (fields.length > 0) form.setFields(fields);
  }, [form, error]);
}
