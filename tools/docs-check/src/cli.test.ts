import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from './cli.ts';
import { loadDocsInput } from './files.ts';
import { validFiles } from '../test-support/fixtures.ts';

let root: string;
let out: string[];
let err: string[];
const output = () => ({ log: (m: string) => out.push(m), error: (m: string) => err.push(m) });

const write = (rel: string, content: string) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-check-'));
  out = [];
  err = [];
  write('specs/phase-1/P1-08-quotations.md', '# spec');
  write('specs/phase-1/notes.txt', 'ignored');
  write('specs/README.md', 'ignored');
  write('specs/tools/ignored.md', 'ignored');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('loadDocsInput', () => {
  it('returns undefined when docs/discovery does not exist', () => {
    expect(loadDocsInput(root)).toBeUndefined();
  });

  it('reads markdown files recursively and spec ids from file names', () => {
    write('docs/discovery/glossary.md', 'g');
    write('docs/discovery/forms/quotation.md', 'q');
    write('docs/discovery/forms/photo.png', 'binary');
    const input = loadDocsInput(root);
    expect(Object.keys(input?.files ?? {}).sort()).toEqual(['forms/quotation.md', 'glossary.md']);
    expect([...(input?.specIds ?? [])]).toEqual(['P1-08']);
    expect(input?.exists('glossary.md')).toBe(true);
    expect(input?.exists('nope.md')).toBe(false);
  });
});

describe('main', () => {
  it('fails when the discovery folder is missing', () => {
    expect(main(root, output())).toBe(1);
    expect(err).toEqual(['docs:check: docs/discovery not found']);
  });

  it('passes a valid pack and reports the file count', () => {
    for (const [rel, content] of Object.entries(validFiles()))
      write(`docs/discovery/${rel}`, content);
    expect(main(root, output())).toBe(0);
    expect(out).toEqual(['docs:check OK (' + Object.keys(validFiles()).length + ' files)']);
    expect(err).toEqual([]);
  });

  it('reports every problem with file and line and returns 1', () => {
    write('docs/discovery/glossary.md', 'Phone 0300-1234567\n');
    expect(main(root, output())).toBe(1);
    expect(
      err.some((m) => m.startsWith('docs/discovery/glossary.md:1: looks like a real mobile')),
    ).toBe(true);
    expect(err.at(-1)).toMatch(/^docs:check failed with \d+ problem\(s\)$/);
    expect(out).toEqual([]);
  });
});
