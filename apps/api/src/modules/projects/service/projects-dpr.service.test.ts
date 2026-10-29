import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PM,
  SUPERVISOR,
  SUPERVISOR2,
  createProjectsKit,
  type ProjectsKit,
} from '../test-support.js';

let kit: ProjectsKit;
beforeAll(async () => {
  kit = await createProjectsKit();
}, 120_000);
afterAll(() => kit.close());

const tx = <T>(run: (db: ProjectsKit['db']) => Promise<T>) => kit.db.transaction(run);
const pm = () => kit.actorFor(PM);
const system = { userId: null, requestId: null };

const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return undefined;
};

describe('task interfaces for daily reports (P1-15 BR-4)', () => {
  it('reads one task and refuses a task of another project or a missing one', async () => {
    const project = await kit.activeProject();
    const other = await kit.activeProject();
    const task = await tx((db) =>
      kit.projects.service.createTask(project.id, { name: 'Foundation' }, pm(), db),
    );
    expect((await kit.projects.getTask(kit.db, project.id, task.id)).name).toBe('Foundation');
    expect(await codeOf(() => kit.projects.getTask(kit.db, other.id, task.id))).toBe(
      'task_not_found',
    );
    expect(await codeOf(() => kit.projects.getTask(kit.db, project.id, other.id))).toBe(
      'task_not_found',
    );
  });

  it('sets the percent and derives the status; a repeat changes nothing', async () => {
    const project = await kit.activeProject();
    const task = await tx((db) =>
      kit.projects.service.createTask(project.id, { name: 'Walls' }, pm(), db),
    );
    const set = (percent: number) =>
      tx((db) => kit.projects.updateTaskProgress(project.id, task.id, percent, system, db));
    const half = await set(50);
    expect([half.percentComplete, half.status]).toEqual([50, 'doing']);
    const same = await set(50);
    expect(same.version).toBe(half.version);
    const done = await set(100);
    expect([done.percentComplete, done.status]).toEqual([100, 'done']);
    const back = await set(0);
    expect([back.percentComplete, back.status]).toEqual([0, 'todo']);
    expect(
      (await kit.projects.service.listTasks(kit.db, project.id, pm()))[0]?.percentComplete,
    ).toBe(0);
  });

  it('refuses a percent outside 0 to 100, a foreign task and a missing task or project', async () => {
    const project = await kit.activeProject();
    const other = await kit.activeProject();
    const task = await tx((db) =>
      kit.projects.service.createTask(project.id, { name: 'Roof' }, pm(), db),
    );
    const set = (projectId: string, taskId: string, percent: number) =>
      tx((db) => kit.projects.updateTaskProgress(projectId, taskId, percent, system, db));
    expect(await codeOf(() => set(project.id, task.id, 101))).toBe('percent_invalid');
    expect(await codeOf(() => set(other.id, task.id, 10))).toBe('task_not_found');
    expect(await codeOf(() => set(project.id, other.id, 10))).toBe('task_not_found');
    expect(await codeOf(() => set(task.id, task.id, 10))).toBe('project_not_found');
  });
});

describe('supervised projects (P1-15 BR-6)', () => {
  it('lists active projects with a supervisor on the date, with their manager', async () => {
    const supervised = await kit.activeProject();
    const unsupervised = await kit.activeProject();
    const ended = await kit.activeProject();
    await tx((db) =>
      kit.projects.service.setSupervisors(
        supervised.id,
        [{ userId: SUPERVISOR, fromDate: '2026-10-01' }, { userId: SUPERVISOR2 }],
        pm(),
        db,
      ),
    );
    await tx((db) =>
      kit.projects.service.setSupervisors(
        ended.id,
        [{ userId: SUPERVISOR, fromDate: '2026-09-01', toDate: '2026-10-10' }],
        pm(),
        db,
      ),
    );
    const onDay = await kit.projects.listSupervisedProjects(kit.db, '2026-10-25');
    const found = onDay.find((p) => p.projectId === supervised.id);
    expect(found?.supervisorIds).toEqual([SUPERVISOR, SUPERVISOR2].sort());
    expect(found?.code).toBe(supervised.code);
    expect(onDay.some((p) => p.projectId === unsupervised.id)).toBe(false);
    expect(onDay.some((p) => p.projectId === ended.id)).toBe(false);
    const early = await kit.projects.listSupervisedProjects(kit.db, '2026-09-20');
    expect(early.some((p) => p.projectId === ended.id)).toBe(true);
    expect(early.some((p) => p.projectId === supervised.id)).toBe(false);
    expect(await codeOf(() => kit.projects.listSupervisedProjects(kit.db, '2026-13-01'))).toBe(
      'invalid_date',
    );
  });
});
