import { isoDate, type DecisionIssue } from './checks.js';

/** The decision records P0-03 owns, named ADR-001 to ADR-008. */
export const adrIds = [
  'ADR-001',
  'ADR-002',
  'ADR-003',
  'ADR-004',
  'ADR-005',
  'ADR-006',
  'ADR-007',
  'ADR-008',
] as const;

const approvers = ['accountant', 'owner'];

/** Returns the value of a "- Key: value" line and the line number, or undefined when absent. */
function field(text: string, key: string): { value: string; line: number } | undefined {
  const lines = text.split(/\r?\n/);
  const pattern = new RegExp(String.raw`^(?:[-*]\s*)?${key}:\s*(.*)$`, 'i');
  for (const [index, line] of lines.entries()) {
    const match = pattern.exec(line.trim());
    if (match) return { value: (match[1] as string).trim(), line: index + 1 };
  }
  return undefined;
}

/** BR-3 and BR-6: every ADR has a status; an accepted one names an approver and a date. */
export function validateAdr(file: string, text: string): DecisionIssue[] {
  const status = field(text, 'Status');
  if (!status || !['pending', 'accepted'].includes(status.value)) {
    return [{ file, row: status?.line ?? 0, message: 'Status must be "pending" or "accepted"' }];
  }
  if (status.value === 'pending') return [];
  const issues: DecisionIssue[] = [];
  const by = field(text, 'Decided by');
  const names = (by?.value ?? '').split(/,|\band\b/i).map((name) => name.trim().toLowerCase());
  if (names.some((name) => !approvers.includes(name))) {
    issues.push({
      file,
      row: by?.line ?? status.line,
      message: 'an accepted ADR needs "Decided by" naming the accountant and/or the owner',
    });
  }
  const date = field(text, 'Date');
  if (!date || !isoDate(date.value)) {
    issues.push({
      file,
      row: date?.line ?? status.line,
      message: 'an accepted ADR needs "Date" in yyyy-mm-dd form',
    });
  }
  return issues;
}

/** Checks all eight ADRs. `files` maps file names (ADR-001-....md) to text. */
export function validateAdrs(files: Readonly<Record<string, string>>): DecisionIssue[] {
  const entries = Object.entries(files);
  return adrIds.flatMap((id) => {
    const entry = entries.find(([name]) => name.startsWith(`${id}-`));
    return entry
      ? validateAdr(entry[0], entry[1])
      : [{ file: id, row: 0, message: 'decision record is missing' }];
  });
}
