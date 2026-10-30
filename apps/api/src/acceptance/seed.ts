import { generateSyntheticCompany, type SyntheticCompany } from '@emporium/domain/acceptance';
import type { Harness } from './harness.js';
import { client, val } from './scenario-kit.js';

export interface SeedSummary {
  parties: number;
  itemCategories: number;
  items: number;
  costCodes: number;
  users: number;
  workers: number;
  teams: number;
  projects: number;
}

/**
 * Loads a synthetic company through the real API (P1-21 BR-1). The loader acts as the admin, owner
 * and project manager of the harness, so every rule of the modules applies to the seed data too.
 */
export async function loadSyntheticCompany(
  h: Harness,
  company: SyntheticCompany,
): Promise<SeedSummary> {
  const c = client(h);
  const ids = {
    parties: [] as string[],
    categories: new Map<string, string>(),
    costCodes: [] as string[],
    users: new Map<string, string>(),
    workers: new Map<string, string>(),
  };

  for (const user of company.users) {
    const created = await c.send('admin', 'POST', '/admin/users', {
      email: user.email,
      fullName: user.fullName,
      roles: [user.role],
    });
    ids.users.set(user.email, val(created.body, 'id'));
  }
  for (const party of company.parties) {
    const created = await c.send('admin', 'POST', '/master/parties', {
      name: party.name,
      roles: party.roles,
      city: party.city,
      phone: party.phone,
    });
    ids.parties.push(val(created.body, 'id'));
  }
  for (const category of company.itemCategories) {
    const created = await c.send('admin', 'POST', '/master/item-categories', category);
    ids.categories.set(category.code, val(created.body, 'id'));
  }
  for (const item of company.items) {
    await c.send('admin', 'POST', '/master/items', {
      code: item.code,
      name: item.name,
      categoryId: ids.categories.get(item.categoryCode),
      unitCode: item.unitCode,
      itemKind: item.itemKind,
      defaultTaxKind: 'goods',
    });
  }
  for (const costCode of company.costCodes) {
    const created = await c.send('admin', 'POST', '/master/cost-codes', costCode);
    ids.costCodes.push(val(created.body, 'id'));
  }
  for (const worker of company.workers) {
    const created = await c.send('owner', 'POST', '/workforce/workers', {
      code: worker.code,
      fullName: worker.fullName,
      cnic: worker.cnic,
      phone: worker.phone,
      tradeCode: worker.tradeCode,
      employmentType: worker.employmentType,
      joinedOn: '2026-01-01',
    });
    const workerId = val(created.body, 'id');
    ids.workers.set(worker.code, workerId);
    await c.send('owner', 'POST', `/workforce/workers/${workerId}/rates`, {
      payBasis: worker.payBasis,
      amount: worker.amount,
      effectiveFrom: '2026-01-01',
    });
  }
  for (const team of company.teams) {
    const created = await c.send('pm', 'POST', '/workforce/teams', {
      name: team.name,
      supervisorUserId: ids.users.get(team.supervisorEmail),
    });
    const url = `/workforce/teams/${val(created.body, 'id')}`;
    await c.send('pm', 'PUT', `${url}/members`, {
      workerIds: team.workerCodes.map((code) => ids.workers.get(code)),
      version: await c.versionOf('pm', url),
    });
  }
  for (const project of company.projects) {
    const created = await c.send('pm', 'POST', '/projects', {
      name: project.name,
      partyId: ids.parties[project.clientIndex],
      sector: project.sector,
      originalContractValue: project.contractValue,
    });
    const url = `/projects/${val(created.body, 'id')}`;
    await c.send('pm', 'PUT', `${url}/budget`, {
      version: await c.versionOf('pm', url),
      lines: project.budget.map((line) => ({
        costCodeId: ids.costCodes[line.costCodeIndex],
        budgetAmount: line.amount,
      })),
    });
  }

  // The scheduler delivers events in production; the loader does it so no event is left waiting.
  await c.deliver();

  return {
    parties: company.parties.length,
    itemCategories: company.itemCategories.length,
    items: company.items.length,
    costCodes: company.costCodes.length,
    users: company.users.length,
    workers: company.workers.length,
    teams: company.teams.length,
    projects: company.projects.length,
  };
}

/** The company the pilot uses unless a seed is given. */
export const PILOT_SEED = 20261026;

export function pilotCompany(allowGovernmentData: boolean): SyntheticCompany {
  return generateSyntheticCompany({ seed: PILOT_SEED, allowGovernmentData });
}
