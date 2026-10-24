const pad = (n: number) => String(n).padStart(2, '0');

/** `dd/mm/yyyy` in Asia/Karachi (constitution 8); the UI shows business dates in local time. */
export function formatDate(value: string | Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(value));
}

/** `dd/mm/yyyy hh:mm` in UTC, as used by the audit log. */
export function formatDateTimeUtc(value: string | Date): string {
  const d = new Date(value);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const amountFormat = new Intl.NumberFormat('en-PK', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Amounts are decimal strings from the API; the display grouping comes from the `en-PK` locale. */
export const formatAmount = (value: string): string => amountFormat.format(value as `${number}`);
