// P1-21 BR-1: a deterministic synthetic company for the pilot. Everything is derived from the seed;
// names, CNICs and phone numbers use reserved patterns that no real person can hold.

export interface SyntheticParty {
  name: string;
  roles: ('client' | 'vendor')[];
  city: string;
  phone: string;
}

export interface SyntheticCategory {
  code: string;
  name: string;
}

export interface SyntheticItem {
  code: string;
  name: string;
  categoryCode: string;
  unitCode: string;
  itemKind: 'material' | 'consumable';
}

export interface SyntheticCostCode {
  code: string;
  name: string;
  kind: 'material' | 'labour' | 'subcontract' | 'equipment' | 'overhead';
}

export interface SyntheticUser {
  email: string;
  fullName: string;
  role: string;
}

export interface SyntheticWorker {
  code: string;
  fullName: string;
  cnic: string;
  phone: string;
  tradeCode: string;
  employmentType: 'daily' | 'permanent';
  payBasis: 'daily_rate' | 'monthly_salary';
  amount: string;
}

export interface SyntheticTeam {
  name: string;
  supervisorEmail: string;
  workerCodes: string[];
}

export interface SyntheticProject {
  name: string;
  clientIndex: number;
  sector: 'private' | 'government';
  contractValue: string;
  /** Budget per cost code, as indexes into `costCodes`. */
  budget: { costCodeIndex: number; amount: string }[];
}

export interface SyntheticCompany {
  parties: SyntheticParty[];
  itemCategories: SyntheticCategory[];
  items: SyntheticItem[];
  costCodes: SyntheticCostCode[];
  users: SyntheticUser[];
  workers: SyntheticWorker[];
  teams: SyntheticTeam[];
  projects: SyntheticProject[];
}

export interface SyntheticOptions {
  seed: number;
  /** The government project is generated only when the environment allows government data. */
  allowGovernmentData: boolean;
}

/** mulberry32: a small seeded generator, so the same seed gives the same company. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

const CITIES = ['Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad'] as const;
const UNITS = ['nos', 'kg', 'm', 'bag', 'ton', 'sqft'] as const;
const TRADES = ['mason', 'helper', 'carpenter', 'steel_fixer', 'painter', 'electrician'] as const;
const COST_KINDS = ['material', 'labour', 'subcontract', 'equipment', 'overhead'] as const;
const USER_ROLES = [
  'admin',
  'management',
  'management',
  'project_manager',
  'project_manager',
  'procurement',
  'storekeeper',
  'accountant',
  'supervisor',
  'supervisor',
  'supervisor',
  'service_coordinator',
] as const;

export const SYNTHETIC_COUNTS = {
  parties: 30,
  items: 200,
  categories: 10,
  costCodes: 60,
  users: 12,
  workers: 50,
  teams: 6,
  projects: 6,
} as const;

/** BR-1: 30 parties, 200 items, 60 cost codes, 50 workers in 6 teams, 12 users and 6 projects. */
export function generateSyntheticCompany(options: SyntheticOptions): SyntheticCompany {
  const next = random(options.seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
  const between = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));

  const parties = Array.from({ length: SYNTHETIC_COUNTS.parties }, (_, i): SyntheticParty => {
    const client = i % 2 === 0;
    return {
      name: `Synthetic ${client ? 'Client' : 'Vendor'} ${pad(i + 1, 3)}`,
      roles: [client ? 'client' : 'vendor'],
      city: pick(CITIES),
      // 0399 is not an assigned mobile prefix (assigned ones run from 0300 to 0349).
      phone: `0399-0${pad(i + 1, 6)}`,
    };
  });

  const itemCategories = Array.from(
    { length: SYNTHETIC_COUNTS.categories },
    (_, i): SyntheticCategory => ({
      code: `CAT-${pad(i + 1, 2)}`,
      name: `Synthetic category ${i + 1}`,
    }),
  );

  const items = Array.from({ length: SYNTHETIC_COUNTS.items }, (_, i): SyntheticItem => ({
    code: `ITM-${pad(i + 1, 4)}`,
    name: `Synthetic item ${pad(i + 1, 4)}`,
    categoryCode: (itemCategories[i % itemCategories.length] as SyntheticCategory).code,
    unitCode: pick(UNITS),
    itemKind: i % 5 === 0 ? 'consumable' : 'material',
  }));

  const costCodes = Array.from(
    { length: SYNTHETIC_COUNTS.costCodes },
    (_, i): SyntheticCostCode => ({
      // 1xx..: far from the seeded H-25 codes (100, 200, 300, 500) so the two sets never collide.
      code: `9${pad(i + 1, 3)}`,
      name: `Synthetic cost code ${i + 1}`,
      kind: COST_KINDS[i % COST_KINDS.length] as SyntheticCostCode['kind'],
    }),
  );

  const users = USER_ROLES.map((role, i): SyntheticUser => ({
    email: `user${pad(i + 1, 2)}@pilot.test`,
    fullName: `Synthetic User ${pad(i + 1, 2)}`,
    role,
  }));
  const supervisors = users.filter((user) => user.role === 'supervisor');

  const workers = Array.from({ length: SYNTHETIC_COUNTS.workers }, (_, i): SyntheticWorker => {
    const salaried = i % 10 === 0;
    return {
      code: `W-${pad(i + 1, 3)}`,
      fullName: `Synthetic Worker ${pad(i + 1, 3)}`,
      // The 00000 area prefix is never issued, so no real CNIC can match.
      cnic: `00000-${pad(i + 1, 7)}-0`,
      phone: `0399-1${pad(i + 1, 6)}`,
      tradeCode: pick(TRADES),
      employmentType: salaried ? 'permanent' : 'daily',
      payBasis: salaried ? 'monthly_salary' : 'daily_rate',
      amount: salaried ? String(between(30, 45) * 1000) : String(between(8, 20) * 100),
    };
  });

  const teams = Array.from({ length: SYNTHETIC_COUNTS.teams }, (_, i): SyntheticTeam => ({
    name: `Synthetic team ${i + 1}`,
    // Three supervisors lead two teams each.
    supervisorEmail: (supervisors[i % supervisors.length] as SyntheticUser).email,
    workerCodes: workers
      .filter((_, workerIndex) => workerIndex % SYNTHETIC_COUNTS.teams === i)
      .map((worker) => worker.code),
  }));

  const clientIndexes = parties.flatMap((party, i) => (party.roles[0] === 'client' ? [i] : []));
  const projects = Array.from({ length: SYNTHETIC_COUNTS.projects }, (_, i): SyntheticProject => {
    const government = options.allowGovernmentData && i === SYNTHETIC_COUNTS.projects - 1;
    const contract = between(40, 400) * 10000;
    return {
      name: `Synthetic project ${i + 1}`,
      clientIndex: clientIndexes[i % clientIndexes.length] as number,
      sector: government ? 'government' : 'private',
      contractValue: `${contract}.00`,
      budget: [0, 1, 2].map((offset) => ({
        costCodeIndex: (i * 3 + offset) % costCodes.length,
        amount: `${Math.round(contract / 4)}.00`,
      })),
    };
  });

  return { parties, itemCategories, items, costCodes, users, workers, teams, projects };
}

/** Patterns that would mean real personal data slipped in (BR-1, T-6): a CNIC or a mobile number. */
const REAL_CNIC = /\b[1-7]\d{4}-\d{7}-\d\b|\b[1-7]\d{12}\b/;
const REAL_MOBILE = /(?:\+92|0092|92|0)[- ]?3[0-4]\d[- ]?\d{7}\b/;

/** True when the text holds something that looks like a real CNIC or Pakistani mobile number. */
export function looksLikeRealPersonalData(text: string): boolean {
  return REAL_CNIC.test(text) || REAL_MOBILE.test(text);
}
