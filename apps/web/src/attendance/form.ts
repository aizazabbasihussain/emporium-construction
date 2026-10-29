import type { EntryStatus } from '@emporium/shared';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import type { Grid, SheetBody } from './api';

/** One project share of a worker's day, as typed: the share is a percent. */
export interface SplitDraft {
  projectId: string;
  percent: string;
}

export interface RowDraft {
  workerId: string;
  code: string;
  fullName: string;
  status: EntryStatus;
  overtime: string;
  overtimeProjectId: string;
  remarks: string;
  splits: SplitDraft[];
}

export const isWorked = (status: EntryStatus): boolean =>
  status === 'present' || status === 'half_day';

export const karachiToday = (now = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(now);

/** Shares are kept in hundredths of a percent, as whole numbers, so nothing is rounded by accident. */
export function percentToUnits(percent: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(percent.trim());
  if (match === null) return null;
  const units = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return units > 0 && units <= 10000 ? units : null;
}

/** 60 -> "0.6000", 33.33 -> "0.3333". */
export function percentToFraction(percent: string): string | null {
  const units = percentToUnits(percent);
  if (units === null) return null;
  const text = String(units).padStart(5, '0');
  return `${text.slice(0, 1)}.${text.slice(1)}`;
}

/** "0.6000" -> "60", "0.3333" -> "33.33". */
export function fractionToPercent(fraction: string): string {
  const units = Number(fraction.replace('.', ''));
  const rest = String(units % 100)
    .padStart(2, '0')
    .replace(/0$/, '');
  return rest === '0' ? String(Math.floor(units / 100)) : `${Math.floor(units / 100)}.${rest}`;
}

const blankRow = (
  member: { workerId: string; code: string; fullName: string },
  projectId: string,
): RowDraft => ({
  workerId: member.workerId,
  code: member.code,
  fullName: member.fullName,
  status: 'present',
  overtime: '',
  overtimeProjectId: '',
  remarks: '',
  splits: [{ projectId, percent: '100' }],
});

/**
 * The rows of the grid: the saved entries when there is a sheet, otherwise every member of the team
 * on the date, present on the default project.
 */
export function rowsFromGrid(grid: Grid, defaultProjectId: string): RowDraft[] {
  if (grid.sheet === null) return grid.members.map((member) => blankRow(member, defaultProjectId));
  return grid.sheet.entries.map((entry) => ({
    workerId: entry.workerId,
    code: entry.workerCode,
    fullName: entry.workerName,
    status: entry.status,
    overtime: Number(entry.overtimeHours) === 0 ? '' : entry.overtimeHours,
    overtimeProjectId: entry.overtimeProjectId ?? '',
    remarks: entry.remarks ?? '',
    splits: entry.allocations.map((a) => ({
      projectId: a.projectId,
      percent: fractionToPercent(a.fraction),
    })),
  }));
}

export type RowProblem = 'shares' | 'project' | 'overtime';

/** The first thing wrong with a row, if anything; the API checks everything again. */
export function rowProblem(row: RowDraft): RowProblem | null {
  const hours = row.overtime.trim();
  if (hours !== '' && !(/^\d{1,2}(\.\d{1,2})?$/.test(hours) && Number(hours) <= 8)) {
    return 'overtime';
  }
  if (!isWorked(row.status)) return null;
  if (row.splits.some((split) => split.projectId === '')) return 'project';
  const units = row.splits.map((split) => percentToUnits(split.percent));
  if (units.includes(null)) return 'shares';
  return units.reduce<number>((sum, value) => sum + (value ?? 0), 0) === 10000 ? null : 'shares';
}

export function sheetBody(rows: readonly RowDraft[], version: number | undefined): SheetBody {
  return {
    ...(version === undefined ? {} : { version }),
    entries: rows.map((row) => {
      const worked = isWorked(row.status);
      const hours = row.overtime.trim();
      return {
        workerId: row.workerId,
        status: row.status,
        ...(worked && hours !== '' ? { overtimeHours: hours } : {}),
        ...(worked && hours !== '' && row.overtimeProjectId !== ''
          ? { overtimeProjectId: row.overtimeProjectId }
          : {}),
        ...(row.remarks.trim() === '' ? {} : { remarks: row.remarks.trim() }),
        ...(worked
          ? {
              allocations: row.splits.map((split) => ({
                projectId: split.projectId,
                fraction: percentToFraction(split.percent) as string,
              })),
            }
          : {}),
      };
    }),
  };
}

export function useErrorText() {
  const { t } = useTranslation();
  return (cause: unknown): string =>
    cause instanceof ApiError
      ? t(`attendance.errors.${cause.code}`, { defaultValue: cause.message })
      : t('common.saveError');
}
