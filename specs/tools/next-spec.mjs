#!/usr/bin/env node
// Picks the next spec an agent may build, applying specs/01-agent-workflow.md section 1 and 2.
// Usage: node specs/tools/next-spec.mjs [--json]
// Eligible = status not-started, every dependency done, and no open human input with "default allowed: no".
// Prints the lowest-numbered eligible spec. Exit code 0 if one exists, 3 if none (reasons are printed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  const out = {};
  for (const line of (m?.[1] ?? '').split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*?)\s*(#.*)?$/);
    if (!kv) continue;
    out[kv[1]] = kv[2].startsWith('[')
      ? kv[2].slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
      : kv[2];
  }
  return out;
}

const inputs = {};
for (const row of fs.readFileSync(path.join(root, '03-human-inputs.md'), 'utf8').split('\n')) {
  const cells = row.split('|').map((c) => c.trim());
  if (/^H-\d+$/.test(cells[1] ?? '')) {
    inputs[cells[1]] = { decision: cells[2], defaultAllowed: cells[5] === 'yes', status: cells[cells.length - 2] };
  }
}

const specs = [];
for (const dir of fs.readdirSync(root).filter((d) => /^phase-\d+$/.test(d))) {
  for (const file of fs.readdirSync(path.join(root, dir)).filter((f) => /^P\d+-\d+-.+\.md$/.test(f))) {
    const fm = frontmatter(fs.readFileSync(path.join(root, dir, file), 'utf8'));
    specs.push({ ...fm, file: `specs/${dir}/${file}` });
  }
}
specs.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
const done = new Set(specs.filter((s) => s.status === 'done').map((s) => s.id));

const eligible = [];
const skipped = [];
for (const s of specs.filter((x) => x.status === 'not-started')) {
  const waitingOn = (s.depends_on ?? []).filter((d) => !done.has(d));
  if (waitingOn.length) continue; // not ready yet; not worth listing
  const needHuman = (s.requires_inputs ?? []).filter(
    (h) => inputs[h]?.status !== 'answered' && !inputs[h]?.defaultAllowed,
  );
  if (needHuman.length) skipped.push({ id: s.id, title: s.title, needs: needHuman.map((h) => ({ id: h, decision: inputs[h]?.decision })) });
  else eligible.push(s);
}

const inFlight = specs.filter((s) => s.status === 'in-progress' || s.status === 'in-review').map((s) => s.id);
const next = inFlight.length ? null : (eligible[0] ?? null);
const result = {
  next: next && { id: next.id, title: next.title, file: next.file },
  inFlight,
  skipped,
  remaining: specs.filter((s) => s.status !== 'done').length,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else if (next) {
  console.log(`${next.id} ${next.title} (${next.file})`);
} else if (inFlight.length) {
  console.log(`Nothing to start: ${inFlight.join(', ')} is already in progress or in review.`);
} else if (result.remaining === 0) {
  console.log('All specs are done.');
} else {
  console.log('No spec can start. Waiting on human inputs:');
  for (const s of skipped) {
    console.log(` ${s.id} ${s.title}`);
    for (const n of s.needs) console.log(`   ${n.id}: ${n.decision}`);
  }
  if (!skipped.length) console.log(' (the remaining specs wait on other specs)');
}
process.exit(next ? 0 : 3);
