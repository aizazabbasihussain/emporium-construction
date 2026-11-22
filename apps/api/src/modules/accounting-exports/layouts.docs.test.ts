import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportLayouts } from '@emporium/domain/accounting';
import { exportCodes } from '@emporium/shared';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.resolve(here, '../../../../../docs/exports');

/** The columns table and the schema version of one documented layout. */
function parse(file: string) {
  const text = readFileSync(path.join(docs, file), 'utf8');
  const version = /^Schema version: (\d+)$/m.exec(text)?.[1];
  const section = text.split('## Columns')[1]?.split('\n## ')[0] ?? '';
  const columns = section
    .split('\n')
    .filter(
      (line) => line.startsWith('| ') && !line.startsWith('| Column') && !line.startsWith('| ---'),
    )
    .map((line) => {
      const [key, type] = line
        .split('|')
        .map((cell) => cell.trim())
        .slice(1);
      return { key, type };
    });
  return { version: Number(version), columns };
}

describe('documented layouts (T-1, BR-3, BR-10)', () => {
  it('has one layout file per export and no other', () => {
    expect(readdirSync(docs).sort()).toEqual([...exportCodes].map((code) => `${code}.md`).sort());
  });

  for (const layout of exportLayouts) {
    it(`${layout.code}: columns, types and schema version match docs/exports/${layout.code}.md`, () => {
      const documented = parse(`${layout.code}.md`);
      expect(documented.version).toBe(layout.version);
      expect(documented.columns).toEqual(layout.columns.map((c) => ({ key: c.key, type: c.type })));
    });
  }

  it('describes the control totals of every export', () => {
    for (const layout of exportLayouts) {
      const text = readFileSync(path.join(docs, `${layout.code}.md`), 'utf8');
      const control = text.split('## Control totals')[1]?.split('\n## ')[0] ?? '';
      for (const column of layout.controlColumns) expect(control, layout.code).toContain(column);
    }
  });

  it('keeps the shared export codes and the layouts in step', () => {
    expect(exportLayouts.map((l) => l.code).sort()).toEqual([...exportCodes].sort());
  });
});
