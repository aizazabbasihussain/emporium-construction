import type { DprWeather } from '@emporium/shared';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import type { Report, ReportBody } from './api';

export interface ManpowerDraft {
  trade: string;
  count: string;
}

export interface TaskDraft {
  taskId: string;
  percent: string;
  note: string;
}

export interface MaterialDraft {
  description: string;
  quantity: string;
  unitCode: string;
}

/** The report form as typed; numbers stay text until they are sent. */
export interface ReportDraft {
  projectId: string;
  reportDate: string;
  weather: DprWeather;
  workDone: string;
  issues: string;
  safetyNotes: string;
  manpower: ManpowerDraft[];
  tasks: TaskDraft[];
  materials: MaterialDraft[];
}

export const MIN_WORK_DONE = 10;

/** Today in Asia/Karachi as yyyy-mm-dd (the business date the API uses). */
export const karachiToday = (now = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(now);

export const emptyDraft = (reportDate: string): ReportDraft => ({
  projectId: '',
  reportDate,
  weather: 'clear',
  workDone: '',
  issues: '',
  safetyNotes: '',
  manpower: [],
  tasks: [],
  materials: [],
});

export const draftOf = (report: Report): ReportDraft => ({
  projectId: report.projectId,
  reportDate: report.reportDate,
  weather: report.weather,
  workDone: report.workDone,
  issues: report.issues,
  safetyNotes: report.safetyNotes,
  manpower: report.manpowerManual.map((m) => ({ trade: m.trade, count: String(m.count) })),
  tasks: report.taskUpdates.map((u) => ({
    taskId: u.taskId,
    percent: String(u.percentComplete),
    note: u.note ?? '',
  })),
  materials: report.materialNotes.map((m) => ({
    description: m.description,
    quantity: m.quantity ?? '',
    unitCode: m.unitCode ?? '',
  })),
});

const wholeNumber = /^\d{1,6}$/;
const quantity = /^\d{1,14}(\.\d{1,4})?$/;

/** The first thing wrong with a draft that cannot be saved, as an i18n key under `dpr.form`. */
export function saveProblem(draft: ReportDraft, isNew: boolean): string | null {
  if (isNew && (draft.projectId === '' || draft.reportDate === '')) return 'projectAndDate';
  if (draft.manpower.some((m) => m.trade.trim() === '' || !wholeNumber.test(m.count.trim()))) {
    return 'manpower';
  }
  if (
    draft.tasks.some(
      (t) => t.taskId === '' || !/^\d{1,3}$/.test(t.percent.trim()) || +t.percent > 100,
    )
  ) {
    return 'tasks';
  }
  if (
    draft.materials.some(
      (m) =>
        m.description.trim() === '' ||
        (m.quantity.trim() !== '' && !quantity.test(m.quantity.trim())),
    )
  ) {
    return 'materials';
  }
  return null;
}

/** BR-3: submitting needs the work done text (the photo rule is checked by the API). */
export const submitProblem = (draft: ReportDraft): string | null =>
  draft.workDone.trim().length < MIN_WORK_DONE ? 'workDone' : null;

export function bodyOf(draft: ReportDraft): ReportBody {
  const optional = (text: string) => (text.trim() === '' ? {} : { note: text.trim() });
  return {
    weather: draft.weather,
    workDone: draft.workDone.trim(),
    issues: draft.issues.trim(),
    safetyNotes: draft.safetyNotes.trim(),
    manpowerManual: draft.manpower.map((m) => ({ trade: m.trade.trim(), count: Number(m.count) })),
    taskUpdates: draft.tasks.map((t) => ({
      taskId: t.taskId,
      percentComplete: Number(t.percent),
      ...optional(t.note),
    })),
    materialNotes: draft.materials.map((m) => ({
      description: m.description.trim(),
      ...(m.quantity.trim() === '' ? {} : { quantity: m.quantity.trim() }),
      ...(m.unitCode.trim() === '' ? {} : { unitCode: m.unitCode.trim() }),
    })),
  };
}

/** A readable message for a refused call: the translation of the error code, else the server text. */
export function useErrorText() {
  const { t } = useTranslation();
  return (cause: unknown): string =>
    cause instanceof ApiError
      ? t(`dpr.errors.${cause.code}`, { defaultValue: cause.message })
      : t('common.saveError');
}
