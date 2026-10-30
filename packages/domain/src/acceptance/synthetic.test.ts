import { describe, expect, it } from 'vitest';
import { SYNTHETIC_COUNTS, generateSyntheticCompany, looksLikeRealPersonalData } from './index.js';

const company = (allowGovernmentData = false, seed = 7) =>
  generateSyntheticCompany({ seed, allowGovernmentData });

describe('synthetic company (P1-21 BR-1)', () => {
  it('produces the sizes the spec asks for', () => {
    const c = company();
    expect(c.parties).toHaveLength(30);
    expect(c.items).toHaveLength(200);
    expect(c.costCodes).toHaveLength(60);
    expect(c.users).toHaveLength(12);
    expect(c.workers).toHaveLength(50);
    expect(c.teams).toHaveLength(6);
    expect(c.projects).toHaveLength(SYNTHETIC_COUNTS.projects);
    expect(c.itemCategories).toHaveLength(10);
  });

  it('is deterministic: the same seed gives the same company, another seed a different one (T-6)', () => {
    expect(JSON.stringify(company())).toBe(JSON.stringify(company()));
    expect(JSON.stringify(company(false, 8))).not.toBe(JSON.stringify(company(false, 7)));
  });

  it('leads six teams with three supervisors and places every worker in exactly one team', () => {
    const c = company();
    expect(new Set(c.teams.map((team) => team.supervisorEmail)).size).toBe(3);
    const placed = c.teams.flatMap((team) => team.workerCodes);
    expect(placed).toHaveLength(50);
    expect(new Set(placed).size).toBe(50);
    for (const team of c.teams) {
      const user = c.users.find((candidate) => candidate.email === team.supervisorEmail);
      expect(user?.role).toBe('supervisor');
    }
  });

  it('spreads the users across the pilot roles', () => {
    const roles = new Set(company().users.map((user) => user.role));
    expect(roles.size).toBe(8);
  });

  it('tags a government project only when government data is allowed', () => {
    expect(company(false).projects.every((project) => project.sector === 'private')).toBe(true);
    const sectors = company(true).projects.map((project) => project.sector);
    expect(sectors.filter((sector) => sector === 'government')).toHaveLength(1);
    expect(sectors.filter((sector) => sector === 'private')).toHaveLength(5);
  });

  it('gives every project a client that is a client party and a three-line budget', () => {
    const c = company();
    for (const project of c.projects) {
      expect(c.parties[project.clientIndex]?.roles).toEqual(['client']);
      expect(project.budget).toHaveLength(3);
      for (const line of project.budget) expect(c.costCodes[line.costCodeIndex]).toBeDefined();
    }
  });

  it('pays salaried workers monthly and the rest by the day', () => {
    const c = company();
    const salaried = c.workers.filter((worker) => worker.payBasis === 'monthly_salary');
    expect(salaried.length).toBe(5);
    expect(salaried.every((worker) => worker.employmentType === 'permanent')).toBe(true);
    expect(c.workers.filter((worker) => worker.payBasis === 'daily_rate')).toHaveLength(45);
  });

  it('contains no real-data patterns (T-6)', () => {
    expect(looksLikeRealPersonalData(JSON.stringify(company(true)))).toBe(false);
  });
});

describe('looksLikeRealPersonalData', () => {
  it('flags a CNIC with dashes, a bare 13-digit CNIC and mobile numbers', () => {
    expect(looksLikeRealPersonalData('35202-1234567-1')).toBe(true);
    expect(looksLikeRealPersonalData('3520212345671')).toBe(true);
    expect(looksLikeRealPersonalData('0300-1234567')).toBe(true);
    expect(looksLikeRealPersonalData('+92 321 7654321')).toBe(true);
  });

  it('accepts the synthetic patterns', () => {
    expect(looksLikeRealPersonalData('00000-0000001-0')).toBe(false);
    expect(looksLikeRealPersonalData('0399-0000001')).toBe(false);
    expect(looksLikeRealPersonalData('plain text')).toBe(false);
  });
});
