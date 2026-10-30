import { describe, expect, it, vi } from 'vitest';
import { createLookups, type ProjectRef } from './context.js';
import type { Db } from '../types.js';

const db = {} as Db;
const projects: ProjectRef[] = [
  { id: 'p-1', code: 'PRJ-0001', name: 'Alpha', status: 'active', startDate: null },
];

const masterData = () => ({
  getItem: vi.fn(async (_db: Db, id: string) =>
    id === 'i-1' ? { code: 'CEM', name: 'Cement' } : undefined,
  ),
  getParty: vi.fn(async (_db: Db, id: string) => (id === 'c-1' ? { name: 'Client' } : undefined)),
  getCostCode: vi.fn(async (_db: Db, id: string) => ({ code: id, name: `Name of ${id}` })),
});

describe('lookups', () => {
  it('names a project, or gives nothing for no project and for one the caller does not reach', () => {
    const look = createLookups({ masterData: masterData() as never }, db, projects);
    expect(look.project('p-1')).toBe('PRJ-0001');
    expect(look.projectName('p-1')).toBe('Alpha');
    expect(look.project(null)).toBe('');
    expect(look.projectName(null)).toBe('');
    expect(look.project('p-9')).toBe('');
    expect(look.projectName('p-9')).toBe('');
  });

  it('finds an item once and gives empty names for an item that is gone', async () => {
    const data = masterData();
    const look = createLookups({ masterData: data as never }, db, projects);
    expect(await look.item('i-1')).toEqual({ code: 'CEM', name: 'Cement' });
    expect(await look.item('i-1')).toEqual({ code: 'CEM', name: 'Cement' });
    expect(await look.item('i-9')).toEqual({ code: '', name: '' });
    expect(await look.item('i-9')).toEqual({ code: '', name: '' });
    expect(data.getItem).toHaveBeenCalledTimes(2);
  });

  it('finds a party once, and gives nothing for no party or an unknown one', async () => {
    const data = masterData();
    const look = createLookups({ masterData: data as never }, db, projects);
    expect(await look.party(null)).toBeNull();
    expect(await look.party('c-1')).toBe('Client');
    expect(await look.party('c-1')).toBe('Client');
    expect(await look.party('c-9')).toBeNull();
    expect(await look.party('c-9')).toBeNull();
    expect(data.getParty).toHaveBeenCalledTimes(2);
  });

  it('finds a cost code once', async () => {
    const data = masterData();
    const look = createLookups({ masterData: data as never }, db, projects);
    expect(await look.costCode('100')).toEqual({ code: '100', name: 'Name of 100' });
    expect(await look.costCode('100')).toEqual({ code: '100', name: 'Name of 100' });
    expect(data.getCostCode).toHaveBeenCalledTimes(1);
  });
});
