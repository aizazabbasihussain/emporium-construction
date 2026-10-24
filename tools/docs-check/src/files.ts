import fs from 'node:fs';
import path from 'node:path';
import type { DocsInput } from './check.ts';

const SPEC_FILE = /^(P\d+-\d+)-.+\.md$/;

function collect(root: string, dir: string, out: Record<string, string>): void {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) collect(root, rel, out);
    else if (entry.name.endsWith('.md')) out[rel] = fs.readFileSync(path.join(root, rel), 'utf8');
  }
}

/** Read docs/discovery and the spec ids under `repoRoot`. Returns undefined if the folder is missing. */
export function loadDocsInput(repoRoot: string): DocsInput | undefined {
  const discovery = path.join(repoRoot, 'docs', 'discovery');
  if (!fs.existsSync(discovery)) return undefined;

  const files: Record<string, string> = {};
  collect(discovery, '', files);

  const specIds = new Set<string>();
  const specsDir = path.join(repoRoot, 'specs');
  for (const phase of fs.readdirSync(specsDir).filter((d) => /^phase-\d+$/.test(d))) {
    for (const file of fs.readdirSync(path.join(specsDir, phase))) {
      const id = SPEC_FILE.exec(file)?.[1];
      if (id) specIds.add(id);
    }
  }

  return {
    files,
    specIds,
    exists: (relativePath) => fs.existsSync(path.join(discovery, relativePath)),
  };
}
