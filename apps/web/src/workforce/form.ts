import type { EmploymentType } from '@emporium/shared';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import type { RateBody, TeamDetail, WorkerBody } from './api';

export interface WorkerDraft {
  fullName: string;
  fatherName: string;
  cnic: string;
  phone: string;
  tradeCode: string;
  employmentType: EmploymentType;
  joinedOn: string;
}

export interface RateDraft {
  payBasis: 'daily_rate' | 'monthly_salary';
  amount: string;
  effectiveFrom: string;
}

export const karachiToday = (now = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(now);

export const emptyWorker = (joinedOn: string): WorkerDraft => ({
  fullName: '',
  fatherName: '',
  cnic: '',
  phone: '',
  tradeCode: '',
  employmentType: 'daily',
  joinedOn,
});

export const emptyRate = (effectiveFrom: string): RateDraft => ({
  payBasis: 'daily_rate',
  amount: '',
  effectiveFrom,
});

const isDate = (text: string) => /^\d{4}-\d{2}-\d{2}$/.test(text);

/** Why the worker form cannot be saved, or null. The API enforces BR-1 again. */
export function workerProblem(draft: WorkerDraft): 'name' | 'trade' | 'joined' | 'cnic' | null {
  if (draft.fullName.trim() === '') return 'name';
  const digits = draft.cnic.replace(/\D/g, '');
  if (draft.cnic.trim() !== '' && digits.length !== 13) return 'cnic';
  if (draft.tradeCode === '') return 'trade';
  if (!isDate(draft.joinedOn)) return 'joined';
  return null;
}

export function workerBody(draft: WorkerDraft): WorkerBody {
  const optional = (text: string) => (text.trim() === '' ? {} : { value: text.trim() });
  const father = optional(draft.fatherName);
  const cnic = optional(draft.cnic);
  const phone = optional(draft.phone);
  return {
    fullName: draft.fullName.trim(),
    ...(father.value === undefined ? {} : { fatherName: father.value }),
    ...(cnic.value === undefined ? {} : { cnic: cnic.value }),
    ...(phone.value === undefined ? {} : { phone: phone.value }),
    tradeCode: draft.tradeCode,
    employmentType: draft.employmentType,
    joinedOn: draft.joinedOn,
  };
}

/** Why the rate form cannot be saved, or null. */
export function rateProblem(draft: RateDraft): 'amount' | 'date' | null {
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(draft.amount.trim()) || Number(draft.amount) <= 0) {
    return 'amount';
  }
  return isDate(draft.effectiveFrom) ? null : 'date';
}

export const rateBody = (draft: RateDraft): RateBody => ({
  payBasis: draft.payBasis,
  amount: draft.amount.trim(),
  effectiveFrom: draft.effectiveFrom,
});

/**
 * The member list of the target team once the worker is added (BR-4). The API ends the worker's
 * membership in their old team the day before, so one call moves them.
 */
export function membersAfterMove(target: TeamDetail, workerId: string): string[] {
  const ids = target.members.map((member) => member.workerId);
  return ids.includes(workerId) ? ids : [...ids, workerId];
}

export function useErrorText() {
  const { t } = useTranslation();
  return (cause: unknown): string =>
    cause instanceof ApiError
      ? t(`workforce.errors.${cause.code}`, { defaultValue: cause.message })
      : t('common.saveError');
}
