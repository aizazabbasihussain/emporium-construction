import { i18n } from '../i18n';

/** One failed check as the API reports it in `error.details` (a Zod issue). */
export interface ApiIssue {
  code?: string;
  path?: (string | number)[];
  message?: string;
  origin?: string;
  minimum?: number | string;
  maximum?: number | string;
  inclusive?: boolean;
}

const humanize = (key: string) => {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const fieldName = (key: string) => i18n.t(`errors.fields.${key}`, { defaultValue: humanize(key) });

/** "Line 1 - Description" for `['lines', 0, 'description']`; the last key is the field itself. */
export function issueLocation(path: readonly (string | number)[]): {
  where: string;
  field: string;
} {
  const parts: string[] = [];
  let field = '';
  path.forEach((segment, index) => {
    if (typeof segment === 'number') return;
    if (index === path.length - 1) {
      field = fieldName(segment);
      return;
    }
    const next = path[index + 1];
    parts.push(typeof next === 'number' ? `${fieldName(segment)} ${next + 1}` : fieldName(segment));
  });
  // A path that ends on an index ("lines.0") names the row itself.
  if (field === '' && parts.length > 0) field = parts.pop() ?? '';
  return { where: parts.join(' - '), field };
}

function problemText(issue: ApiIssue, field: string): string {
  const t = (key: string, options: Record<string, unknown> = {}) =>
    i18n.t(`errors.validation.${key}`, { field, ...options });
  const min = issue.minimum;
  const max = issue.maximum;
  switch (issue.code) {
    case 'too_small':
      if (issue.origin === 'string')
        return min === 1 ? t('required') : t('minLength', { count: Number(min) });
      if (issue.origin === 'array') return t('minItems', { count: Number(min) });
      return t(issue.inclusive === false ? 'minValueExclusive' : 'minValue', {
        value: String(min),
      });
    case 'too_big':
      if (issue.origin === 'string') return t('maxLength', { count: Number(max) });
      if (issue.origin === 'array') return t('maxItems', { count: Number(max) });
      return t(issue.inclusive === false ? 'maxValueExclusive' : 'maxValue', {
        value: String(max),
      });
    case 'invalid_type':
      return /received (undefined|null)/.test(issue.message ?? '') ? t('required') : t('invalid');
    case 'invalid_format':
      return t('invalidFormat');
    case 'invalid_value':
      return t('notAllowed');
    default:
      return issue.message === undefined ? t('invalid') : `${field}: ${issue.message}`;
  }
}

/** One readable sentence per failed check, for example "Line 1 - Description is required". */
export function describeIssue(issue: ApiIssue): string {
  const { where, field } = issueLocation(issue.path ?? []);
  const text = problemText(issue, field === '' ? i18n.t('errors.fields.name') : field);
  return where === '' ? text : `${where} - ${text}`;
}

/** The sentence the inline banners show instead of "Request validation failed". */
export function summarizeIssues(issues: readonly ApiIssue[], shown = 4): string {
  const lines = issues.map(describeIssue);
  const head = lines.slice(0, shown).join('; ');
  const rest = lines.length - shown;
  const problems =
    rest > 0 ? `${head}; ${i18n.t('errors.validation.more', { count: rest })}` : head;
  return i18n.t('errors.validation.summary', { problems });
}
