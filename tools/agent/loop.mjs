#!/usr/bin/env node
// Runs one fresh Claude Code session per spec until nothing can start (see specs/04-autonomous-run.md).
// Usage: node tools/agent/loop.mjs [--detach] [--max-specs N] [--budget-usd N] [--timeout-min N] [--dry-run]
//   --detach   start the loop as a background process that outlives this terminal (and any Claude session),
//              restarted by a small supervisor if it crashes. Output goes to .agent-logs/.
// Stop early by creating a file named .agent-stop in the repo root.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const self = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const maxSpecs = Number(opt('max-specs', 50));
const budget = opt('budget-usd', '25');
const timeoutMs = Number(opt('timeout-min', 90)) * 60_000;
const dryRun = args.includes('--dry-run');
const logDir = path.join(root, '.agent-logs');
const pidFile = path.join(logDir, 'loop.pid');
const stateFile = path.join(logDir, 'loop-state.json');
const maxRestarts = 3;
fs.mkdirSync(logDir, { recursive: true });

const run = (cmd, argv, extra = {}) =>
  spawnSync(cmd, argv, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32' && cmd !== 'node',
    ...extra,
  });
const git = (...a) => run('git', a);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const stop = (msg, code = 0) => {
  console.log(`\n${msg}`);
  process.exit(code);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const killTree = (child) => {
  if (!child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  else
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
};
const writeState = (state) =>
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ ...state, updated: new Date().toISOString() }, null, 2),
  );

// One child with output streamed to a file (never buffered here). Resolves with its exit code, or "timeout".
const runLogged = (cmd, argv, logFile, env, limitMs) =>
  new Promise((resolve) => {
    const fd = fs.openSync(logFile, 'a');
    const child = spawn(cmd, argv, {
      cwd: root,
      stdio: ['ignore', fd, fd],
      shell: process.platform === 'win32' && cmd !== 'node',
      detached: process.platform !== 'win32',
      windowsHide: true,
      env,
    });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fs.closeSync(fd);
      resolve(result);
    };
    const timer = limitMs
      ? setTimeout(() => {
          killTree(child);
          finish('timeout');
        }, limitMs)
      : undefined;
    child.on('error', () => finish(-1));
    child.on('exit', (code, signal) => {
      // Sweep anything the session left behind (pnpm, vitest, playwright).
      if (signal || code) killTree(child);
      finish(code ?? -1);
    });
  });

// --detach: relaunch this script as a supervisor that is not a child of the current terminal or session.
if (args.includes('--detach')) {
  if (fs.existsSync(pidFile) && alive(Number(fs.readFileSync(pidFile, 'utf8'))))
    stop(
      `Already running (pid ${fs.readFileSync(pidFile, 'utf8')}). Create .agent-stop to stop it.`,
      1,
    );
  const out = fs.openSync(path.join(logDir, `loop-${stamp()}.log`), 'a');
  const passthrough = args.filter((a) => a !== '--detach');
  const child = spawn(process.execPath, [self, '--supervise', ...passthrough], {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  stop(
    `Loop started in the background (pid ${child.pid}). Logs: .agent-logs/. State: .agent-logs/loop-state.json`,
  );
}

// --supervise: run the worker, restart it after an unexpected exit (crash, kill, out of memory).
if (args.includes('--supervise')) {
  fs.writeFileSync(pidFile, String(process.pid));
  const workerArgs = args.filter((a) => a !== '--supervise');
  let restarts = 0;
  for (;;) {
    const code = await runLogged(
      process.execPath,
      [self, '--worker', ...workerArgs],
      path.join(logDir, `worker-${stamp()}.log`),
      process.env,
      0,
    );
    // 0 finished, 1 and 2 are deliberate stops (see below); anything else is a crash.
    if (code === 0 || code === 1 || code === 2) break;
    if (fs.existsSync(path.join(root, '.agent-stop')) || ++restarts > maxRestarts) {
      console.log(`Supervisor giving up after exit ${code} (${restarts - 1} restarts).`);
      break;
    }
    console.log(`Worker exited ${code}; restart ${restarts}/${maxRestarts} in ${restarts * 30}s.`);
    await new Promise((r) => setTimeout(r, restarts * 30_000));
  }
  fs.rmSync(pidFile, { force: true });
  process.exit(0);
}

for (let n = 1; n <= maxSpecs; n++) {
  if (fs.existsSync(path.join(root, '.agent-stop'))) stop('Stopped: .agent-stop file found.');

  // A crashed session leaves uncommitted work on its spec branch: resume it instead of stopping.
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  const dirty = git('status', '--porcelain').stdout.trim();
  const resume = dirty ? branch.match(/^spec\/(P\d-\d{2})-/) : null;
  if (dirty && !resume)
    stop(`Stopped: working tree is not clean on "${branch}". Commit or discard changes first.`, 1);

  if (!resume) {
    for (const step of [
      ['checkout', 'main'],
      ['pull', '--ff-only', 'origin', 'main'],
    ]) {
      const r = git(...step);
      if (r.status !== 0) stop(`Stopped: git ${step.join(' ')} failed.\n${r.stderr}`, 1);
    }
  }

  const pick = run('node', ['specs/tools/next-spec.mjs', '--json']);
  const info = JSON.parse(pick.stdout);
  if (!resume && !info.next) {
    console.log(run('node', ['specs/tools/next-spec.mjs']).stdout);
    stop(
      info.remaining === 0 && !info.inFlight.length
        ? 'All specs are done.'
        : 'Loop finished: no spec can start. Answer the inputs above in specs/03-human-inputs.md (status answered) and start the loop again.',
    );
  }
  const id = resume ? resume[1] : info.next.id;
  const title = resume ? `(resuming on ${branch})` : info.next.title;
  console.log(`\n=== Session ${n}: ${id} ${title} ===`);
  if (dryRun) stop('Dry run: would start a session for this spec.');

  const resumeNote = resume
    ? ` A previous session for this spec stopped early: you are on branch ${branch} with uncommitted work. Do not check out main or discard it. Review it against the spec, run pnpm verify, finish what is missing, and continue from step 3.`
    : '';
  const prompt = `You are the build agent for spec ${id}. Read specs/04-autonomous-run.md and follow it exactly for this one spec. Do not start any other spec.${resumeNote}`;
  const log = path.join(logDir, `${stamp()}-${id}.log`);
  writeState({
    spec: id,
    session: n,
    branch,
    resume: Boolean(resume),
    log: path.relative(root, log),
    pid: process.pid,
  });

  // Bound memory of the session and the test runs it starts (vitest honours VITEST_MAX_WORKERS).
  const env = {
    ...process.env,
    AGENT_LOOP: '1',
    VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? '2',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=4096`.trim(),
  };
  const code = await runLogged(
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
    log,
    env,
    timeoutMs,
  );
  console.log(`Session log: ${path.relative(root, log)} (exit ${code})`);

  // Judge the result from the repository, not from what the agent says.
  if (git('status', '--porcelain').stdout.trim() && code !== 0) {
    // The session died before finishing: leave its branch and files for the next iteration to resume.
    const cur = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
    if (!/^spec\//.test(cur))
      stop(`Stopped: session ended (exit ${code}) with uncommitted changes on "${cur}".`, 2);
    if (n === maxSpecs)
      stop(`Stopped after ${maxSpecs} specs (--max-specs); ${id} is unfinished on ${cur}.`, 2);
    console.log(`${id} unfinished (exit ${code}); resuming on ${cur}.`);
    continue;
  }
  git('checkout', 'main');
  git('pull', '--ff-only', 'origin', 'main');
  const after = JSON.parse(run('node', ['specs/tools/next-spec.mjs', '--json']).stdout);
  const status = fs
    .readFileSync(path.join(root, 'specs', 'STATUS.md'), 'utf8')
    .match(new RegExp(`^\\| ${id} \\|.*?\\| (\\S+) \\|`, 'm'))?.[1];
  if (status !== 'done') {
    stop(
      `Stopped: ${id} is "${status}" on main after the session (exit ${code}, not done). Read ${path.relative(root, log)} and the open PR, then decide.`,
      2,
    );
  }
  console.log(`${id} is done on main. ${after.remaining} specs left.`);
}
stop(`Stopped after ${maxSpecs} specs (--max-specs).`);
