// `pnpm seed:team-setup`: one-time, idempotent load of the owners, project managers, engineers,
// labourers and the two teams (Alpha and Beta), through the real services. Safe to re-run.
import { randomInt } from 'node:crypto';
import { createRuntime } from './compose.js';
import { loadConfig } from './config.js';
import type { Actor } from './modules/workforce/types.js';

const today = new Date().toISOString().slice(0, 10);

const USERS = [
  { email: 'taimoor@gmail.com', fullName: 'Taimoor', roles: ['management'] },
  { email: 'zeeshan@gmail.com', fullName: 'Zeeshan', roles: ['management'] },
  { email: 'saqlian@gmail.com', fullName: 'Saqlian', roles: ['project_manager', 'supervisor'] },
  { email: 'osama@gmail.com', fullName: 'Osama', roles: ['project_manager', 'supervisor'] },
];

const TRADES = [{ code: 'civil_engineer', name: 'Civil engineer' }];

type Person = { name: string; father: string; trade: string; team: 'alpha' | 'beta' };
const PEOPLE: Person[] = [
  { name: 'Zuki Abbasi', father: 'Abdul Abbasi', trade: 'electrician', team: 'alpha' },
  { name: 'Raj Khan', father: 'Rashid Khan', trade: 'electrician', team: 'beta' },
  { name: 'Mina Raja', father: 'Mukhtar Raja', trade: 'civil_engineer', team: 'alpha' },
  { name: 'Nawal', father: 'Nadeem Ahmed', trade: 'civil_engineer', team: 'alpha' },
  { name: 'Shahid', father: 'Shafiq Ahmed', trade: 'civil_engineer', team: 'beta' },
  { name: 'Imran Ali', father: 'Liaqat Ali', trade: 'mason', team: 'alpha' },
  { name: 'Bilal Hussain', father: 'Ghulam Hussain', trade: 'mason', team: 'alpha' },
  { name: 'Kashif Mehmood', father: 'Mehmood Ahmed', trade: 'mason', team: 'alpha' },
  { name: 'Usman Tariq', father: 'Tariq Mehmood', trade: 'helper', team: 'alpha' },
  { name: 'Waseem Akram', father: 'Akram Din', trade: 'helper', team: 'alpha' },
  { name: 'Adnan Shah', father: 'Anwar Shah', trade: 'helper', team: 'alpha' },
  { name: 'Faisal Iqbal', father: 'Iqbal Hussain', trade: 'mason', team: 'beta' },
  { name: 'Rizwan Butt', father: 'Riaz Butt', trade: 'mason', team: 'beta' },
  { name: 'Nasir Javed', father: 'Javed Iqbal', trade: 'mason', team: 'beta' },
  { name: 'Shoaib Malik', father: 'Malik Aslam', trade: 'helper', team: 'beta' },
  { name: 'Zahid Rafiq', father: 'Rafiq Ahmed', trade: 'helper', team: 'beta' },
  { name: 'Asif Raza', father: 'Raza Khan', trade: 'helper', team: 'beta' },
];

const TEAMS = [
  { key: 'alpha', name: 'Team Alpha', supervisor: 'saqlian@gmail.com' },
  { key: 'beta', name: 'Team Beta', supervisor: 'osama@gmail.com' },
] as const;

/** 13 random digits; the first is 1-7 (a plausible province code). Not a real person's CNIC. */
const randomCnic = () =>
  String(randomInt(1, 8)) + Array.from({ length: 12 }, () => randomInt(0, 10)).join('');

const runtime = await createRuntime(loadConfig(process.env));
try {
  const { db, identity, workforce } = runtime;
  const admin = (await identity.users.list(db)).find(
    (user) => user.roles.includes('admin') && user.status === 'active',
  );
  if (admin === undefined) {
    throw new Error(
      'seed:team-setup: no active admin user; set ADMIN_EMAIL and start the API once.',
    );
  }
  const actor: Actor = {
    userId: admin.id,
    roles: ['admin'],
    scopes: [],
    permissions: new Set<string>(),
    requestId: null,
  };
  const ctx = { actorUserId: admin.id, requestId: null };

  await db.transaction(async (tx) => {
    // Users
    const users = await identity.users.list(tx);
    for (const u of USERS) {
      if (users.some((x) => x.email === u.email)) continue;
      await identity.users.create(u, ctx, tx);
      console.log('user   +', u.email);
    }
    const byEmail = new Map((await identity.users.list(tx)).map((u) => [u.email, u]));

    // Trades
    const trades = new Set((await workforce.workers.listTrades(tx)).map((t) => t.code));
    for (const t of TRADES) {
      if (trades.has(t.code)) continue;
      await workforce.workers.createTrade(t, actor, tx);
      console.log('trade  +', t.code);
    }

    // Teams
    const teamId = new Map<string, string>();
    const existingTeams = await workforce.teams.list(tx, actor);
    for (const t of TEAMS) {
      const found = existingTeams.find((x) => x.name === t.name);
      if (found !== undefined) {
        teamId.set(t.key, found.id);
        continue;
      }
      const supervisor = byEmail.get(t.supervisor);
      if (supervisor === undefined) throw new Error(`supervisor ${t.supervisor} missing`);
      const created = await workforce.teams.create(
        { name: t.name, supervisorUserId: supervisor.id },
        actor,
        tx,
      );
      teamId.set(t.key, created.id);
      console.log('team   +', t.name);
    }

    // Workers and memberships
    const have = new Map(
      (
        await tx.query<{ id: string; full_name: string }>(
          'select id, full_name from lab_workers where deleted_at is null',
        )
      ).map((r) => [r.full_name, r.id]),
    );
    for (const p of PEOPLE) {
      let workerId = have.get(p.name);
      if (workerId === undefined) {
        const worker = await workforce.workers.create(
          {
            fullName: p.name,
            fatherName: p.father,
            cnic: randomCnic(),
            tradeCode: p.trade,
            employmentType: 'permanent',
            joinedOn: today,
          },
          actor,
          tx,
        );
        workerId = worker.id;
        console.log('worker +', p.name, `(${p.trade})`);
        await workforce.teams.addMembership(
          { teamId: teamId.get(p.team) as string, workerId, fromDate: today },
          actor,
          tx,
        );
      }
    }
  });
  console.log('seed:team-setup: done');
} finally {
  await runtime.close();
}
