import { Money } from '@emporium/domain/kernel';
import { fiscalLabel, monthOf } from '@emporium/domain/accounting';
import type { MasterData } from '../../masterdata/index.js';
import type { Db } from '../types.js';

const PAGE = 200;

/** Reads every page of a paged query. */
export async function allPages<T>(
  fetch: (limit: number, offset: number) => Promise<{ items: T[]; total: number }>,
): Promise<T[]> {
  const items: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await fetch(PAGE, offset);
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= page.total) return items;
  }
}

/** The day before a yyyy-mm-dd date. */
export function previousDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/** The yyyy-mm months that touch the period, first to last. */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  let [year, month] = monthOf(from).split('-').map(Number) as [number, number];
  const last = monthOf(to);
  for (;;) {
    const label = `${year}-${String(month).padStart(2, '0')}`;
    if (label > last) return months;
    months.push(label);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

export const inPeriod = (date: string, from: string, to: string): boolean =>
  date >= from && date <= to;

export const sumMoney = (values: readonly string[]): string =>
  values.reduce((total, value) => total.add(Money.of(value)), Money.zero()).toString();

export const negate = (value: string): string => Money.of(value).negate().toString();

/** The two label columns every dated register starts with. */
export const periodColumns = (
  date: string,
  startMonth: number,
): { fiscal_year: string; month: string } => ({
  fiscal_year: fiscalLabel(date, startMonth),
  month: monthOf(date),
});

/** Looks a party up once and remembers the name. */
export function partyNamer(masterData: Pick<MasterData, 'getParty'>, db: Db) {
  const names = new Map<string, string>();
  return async (partyId: string | null): Promise<string> => {
    if (partyId === null) return '';
    const known = names.get(partyId);
    if (known !== undefined) return known;
    const party = await masterData.getParty(db, partyId);
    const name = party?.name ?? partyId;
    names.set(partyId, name);
    return name;
  };
}
