#!/usr/bin/env node
// GitHub pull request helper for the agent run (see specs/04-autonomous-run.md).
// Usage:
//   node tools/agent/pr.mjs open <branch> <title> <body-file>
//   node tools/agent/pr.mjs merge <pr-number> [--own-spec <path>] [--timeout-min 30]
// Reads GITHUB_PAT and GITHUB_REPO_URL from the environment or the git-ignored .env.
// `merge` waits for every check on the PR head, refuses protected changes, merges only if all checks pass.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Files an agent may never change and then merge on its own. A human reviews these.
const PROTECTED = [
  /^specs\/00-/,
  /^specs\/01-/,
  /^specs\/02-/,
  /^specs\/03-/,
  /^specs\/04-/,
  /^specs\/CHANGES\.md$/,
  /^specs\/tools\//,
  /^\.github\//,
  /^\.husky\//,
  /^vitest(\.\w+)?\.(ts|js)$/,
  /^eslint\.config\./,
  /^commitlint\.config\./,
  /^\.dependency-cruiser\./,
  /^tools\/depcruise-rules\./,
  /^tools\/agent\//,
  /^\.gitignore$/,
  /^\.env/,
];

function env() {
  const out = { ...process.env };
  const file = path.join(root, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && out[m[1]] === undefined) out[m[1]] = m[2];
    }
  }
  return out;
}
const E = env();
if (!E.GITHUB_PAT || !E.GITHUB_REPO_URL)
  fail('GITHUB_PAT and GITHUB_REPO_URL are required (.env).');
const repo = E.GITHUB_REPO_URL.replace(/^.*github\.com\//, '').replace(/\.git$/, '');

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}
async function api(method, url, body) {
  const res = await fetch(`https://api.github.com/repos/${repo}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${E.GITHUB_PAT}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) fail(`GitHub ${method} ${url} -> ${res.status}: ${json.message ?? text}`);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(branch, title, bodyFile) {
  const body = fs.readFileSync(bodyFile, 'utf8');
  const pr = await api('POST', '/pulls', { head: branch, base: 'main', title, body });
  console.log(pr.number);
}

async function merge(number, flags) {
  const timeoutMs = Number(flags['timeout-min'] ?? 30) * 60_000;
  const pr = await api('GET', `/pulls/${number}`);
  if (pr.merged) return console.log(`PR #${number} is already merged.`);
  if (pr.base.ref !== 'main') fail(`PR #${number} does not target main.`);

  // 1. Protected paths and spec scope.
  const files = (await api('GET', `/pulls/${number}/files?per_page=100`)).map((f) => f.filename);
  const own = flags['own-spec'];
  const touched = files.filter((f) => PROTECTED.some((re) => re.test(f)));
  const otherSpecs = files.filter(
    (f) => /^specs\/phase-\d+\/P\d+-\d+-.+\.md$/.test(f) && f !== own,
  );
  const refused = [...touched, ...otherSpecs];
  if (refused.length) {
    fail(
      `NOT AUTO-MERGED: PR #${number} changes files that need a human review:\n  ${refused.join('\n  ')}`,
      4,
    );
  }

  // 2. Wait for checks on the head commit.
  const sha = pr.head.sha;
  const deadline = Date.now() + timeoutMs;
  let seenAny = false;
  for (;;) {
    const { check_runs: runs } = await api('GET', `/commits/${sha}/check-runs?per_page=100`);
    const status = await api('GET', `/commits/${sha}/status`);
    if (runs.length) seenAny = true;
    const pending = runs.filter((r) => r.status !== 'completed').map((r) => r.name);
    const bad = runs.filter(
      (r) => r.status === 'completed' && !['success', 'skipped', 'neutral'].includes(r.conclusion),
    );
    if (bad.length) {
      fail(
        `CI FAILED on PR #${number}: ${bad.map((r) => `${r.name} (${r.conclusion}) ${r.html_url}`).join('; ')}`,
        5,
      );
    }
    if (status.state === 'failure' || status.state === 'error')
      fail(`Commit status ${status.state} on PR #${number}.`, 5);
    if (seenAny && !pending.length && status.state !== 'pending') break;
    if (Date.now() > deadline)
      fail(
        `Timed out waiting for checks on PR #${number}${seenAny ? ` (pending: ${pending.join(', ')})` : ' (no checks appeared)'}.`,
        6,
      );
    await sleep(20_000);
  }

  // 3. Merge exactly the commit that was checked, then delete the branch.
  await api('PUT', `/pulls/${number}/merge`, {
    merge_method: 'merge',
    sha,
    commit_title: `Merge pull request #${number} from ${repo.split('/')[0]}/${pr.head.ref}`,
  });
  try {
    await api('DELETE', `/git/refs/heads/${pr.head.ref}`);
  } catch {
    /* branch already gone */
  }
  console.log(`PR #${number} merged after green CI.`);
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i];
  else positional.push(rest[i]);
}
if (cmd === 'open' && positional.length === 3) await open(...positional);
else if (cmd === 'merge' && positional.length === 1) await merge(positional[0], flags);
else
  fail(
    'Usage: pr.mjs open <branch> <title> <body-file> | pr.mjs merge <pr-number> [--own-spec <path>] [--timeout-min N]',
    2,
  );
