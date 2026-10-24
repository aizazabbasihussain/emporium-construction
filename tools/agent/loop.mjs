#!/usr/bin/env node
// Runs one fresh Claude Code session per spec until nothing can start (see specs/04-autonomous-run.md).
// Usage: node tools/agent/loop.mjs [--max-specs N] [--budget-usd N] [--dry-run]
// Stop early by creating a file named .agent-stop in the repo root.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const maxSpecs = Number(opt('max-specs', 50));
const budget = opt('budget-usd', '25');
const dryRun = args.includes('--dry-run');
const logDir = path.join(root, '.agent-logs');
fs.mkdirSync(logDir, { recursive: true });

const run = (cmd, argv, extra = {}) =>
  spawnSync(cmd, argv, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32' && cmd !== 'node',
    ...extra,
  });
const git = (...a) => run('git', a);
const stop = (msg, code = 0) => {
  console.log(`\n${msg}`);
  process.exit(code);
};

for (let n = 1; n <= maxSpecs; n++) {
  if (fs.existsSync(path.join(root, '.agent-stop'))) stop('Stopped: .agent-stop file found.');

  // Always start from a clean, current main.
  if (git('status', '--porcelain').stdout.trim())
    stop('Stopped: working tree is not clean. Commit or discard changes first.', 1);
  for (const step of [
    ['checkout', 'main'],
    ['pull', '--ff-only', 'origin', 'main'],
  ]) {
    const r = git(...step);
    if (r.status !== 0) stop(`Stopped: git ${step.join(' ')} failed.\n${r.stderr}`, 1);
  }

  const pick = run('node', ['specs/tools/next-spec.mjs', '--json']);
  const info = JSON.parse(pick.stdout);
  if (!info.next) {
    console.log(run('node', ['specs/tools/next-spec.mjs']).stdout);
    stop(
      info.remaining === 0 && !info.inFlight.length
        ? 'All specs are done.'
        : 'Loop finished: no spec can start. Answer the inputs above in specs/03-human-inputs.md (status answered) and start the loop again.',
    );
  }
  const { id, title } = info.next;
  console.log(`\n=== Session ${n}: ${id} ${title} ===`);
  if (dryRun) stop('Dry run: would start a session for this spec.');

  const prompt = `You are the build agent for spec ${id}. Read specs/04-autonomous-run.md and follow it exactly for this one spec. Do not start any other spec.`;
  const log = path.join(logDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}.log`);
  const r = run(
    'claude',
    [
      '-p',
      JSON.stringify(prompt),
      '--allowedTools',
      '"Bash Read Write Edit Glob Grep"',
      '--max-budget-usd',
      budget,
      '--no-session-persistence',
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  fs.writeFileSync(log, `${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  console.log(`Session log: ${path.relative(root, log)}`);

  // Judge the result from the repository, not from what the agent says.
  git('checkout', 'main');
  git('pull', '--ff-only', 'origin', 'main');
  const after = JSON.parse(run('node', ['specs/tools/next-spec.mjs', '--json']).stdout);
  const status = fs
    .readFileSync(path.join(root, 'specs', 'STATUS.md'), 'utf8')
    .match(new RegExp(`^\\| ${id} \\|.*?\\| (\\S+) \\|`, 'm'))?.[1];
  if (status !== 'done') {
    console.log((r.stdout ?? '').split('\n').slice(-25).join('\n'));
    stop(
      `Stopped: ${id} is "${status}" on main after the session (not done). Read ${path.relative(root, log)} and the open PR, then decide.`,
      2,
    );
  }
  console.log(`${id} is done on main. ${after.remaining} specs left.`);
}
stop(`Stopped after ${maxSpecs} specs (--max-specs).`);
