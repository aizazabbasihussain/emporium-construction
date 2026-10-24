import { describe, expect, it } from 'vitest';
import {
  GAPS_HEADER,
  GLOSSARY_HEADER,
  INVENTORY_HEADER,
  MAPPING_HEADER,
  REQUIRED_FORMS,
  WORKFLOW_HEADER,
  at,
  checkDiscovery,
  parseTables,
  specRefs,
  type DocsInput,
} from './check.ts';
import { inventoryRow, table, validFiles } from '../test-support/fixtures.ts';

const SPECS = new Set(['P1-08', 'P1-11', 'P1-17', 'P2-02', 'P3-01']);

function input(
  files: Record<string, string>,
  exists: (p: string) => boolean = () => false,
): DocsInput {
  return { files, specIds: SPECS, exists };
}

const messages = (files: Record<string, string>, exists?: (p: string) => boolean): string[] =>
  checkDiscovery(input(files, exists)).map((i) => `${i.file}: ${i.message}`);

describe('markdown helpers', () => {
  it('parses tables with CRLF line endings, indentation and trailing prose', () => {
    const text = 'Intro\r\n\r\n  | A | B |\r\n|---|---|\r\n| 1 | 2 |\r\n| 3 | 4 |\r\n\r\nafter\r\n';
    const [parsed] = parseTables(text);
    expect(parsed?.header).toEqual(['a', 'b']);
    expect(parsed?.rows.map((r) => r.cells)).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(parsed?.rows[0]?.line).toBe(5);
    expect(parseTables('| not a table |\nplain text\n')).toEqual([]);
    expect(parseTables('| A |\n|:---:|\n| x |')).toHaveLength(1);
  });

  it('extracts spec ids', () => {
    expect(specRefs('P1-08, P2-02 and text')).toEqual(['P1-08', 'P2-02']);
    expect(specRefs('none')).toEqual([]);
  });
});

describe('at', () => {
  it('returns the element, or an empty string when out of range', () => {
    expect(at(['a', 'b'], 1)).toBe('b');
    expect(at(['a'], 5)).toBe('');
    expect(parseTables('| A |')).toEqual([]);
  });
});

describe('docs checker accepts valid packs (T-2)', () => {
  it('accepts a valid fixture set with every form awaiting and an empty mapping', () => {
    expect(messages(validFiles())).toEqual([]);
  });

  it('accepts a received form with mapped rows, a gap reference and a mixed owner cell', () => {
    const files = validFiles();
    files['forms-inventory.md'] = table(INVENTORY_HEADER, [
      ...REQUIRED_FORMS.filter((s) => s !== 'quotation').map((s) => inventoryRow(s)),
      inventoryRow('quotation', 'received'),
    ]);
    files['gaps.md'] = table(GAPS_HEADER, [['GAP-01', 'Stamp', 'quotation', 'P1-08', 'note']]);
    files['forms/quotation.md'] = table(MAPPING_HEADER, [
      ['Client', 'Client A', 'party_id', 'P1-08', ''],
      ['Stamp', 'blue stamp', '-', 'GAP-01', ''],
      ['Both', 'x', 'y', 'P1-08 / GAP-01', ''],
    ]);
    expect(messages(files)).toEqual([]);
  });

  it('accepts links that resolve inside the pack, outside it, and non-file links', () => {
    const files = validFiles();
    files['glossary.md'] += [
      '[form](forms/quotation.md#top) [spec](../../specs/README.md) [web](https://example.com)',
      '[mail](mailto:a@b.test) [anchor](#top) [empty]()',
    ].join('\n');
    expect(messages(files, (p) => p === '../../specs/README.md')).toEqual([]);
  });
});

describe('docs checker rejects invalid packs (T-1)', () => {
  it('rejects an inventory row linking to an unknown spec id', () => {
    const files = validFiles();
    files['forms-inventory.md'] = table(INVENTORY_HEADER, [
      ...REQUIRED_FORMS.filter((s) => s !== 'quotation').map((s) => inventoryRow(s)),
      inventoryRow('quotation', 'awaiting', 'P9-99'),
    ]);
    expect(messages(files)).toContain('forms-inventory.md: unknown spec id P9-99');
  });

  it('rejects an inventory row without a spec id', () => {
    const files = validFiles();
    files['forms-inventory.md'] = table(INVENTORY_HEADER, [
      ...REQUIRED_FORMS.filter((s) => s !== 'quotation').map((s) => inventoryRow(s)),
      inventoryRow('quotation', 'awaiting', 'none'),
    ]);
    expect(messages(files)).toContain('forms-inventory.md: spec must name a spec id');
  });

  it('rejects a missing required form row', () => {
    const files = validFiles();
    files['forms-inventory.md'] = table(
      INVENTORY_HEADER,
      REQUIRED_FORMS.filter((s) => s !== 'wage-sheet').map((s) => inventoryRow(s)),
    );
    expect(messages(files)).toContain('forms-inventory.md: missing required form: wage-sheet');
  });

  it('rejects duplicate forms, bad status and a missing mapping file', () => {
    const files = validFiles();
    files['forms-inventory.md'] = table(INVENTORY_HEADER, [
      ...REQUIRED_FORMS.map((s) => inventoryRow(s)),
      inventoryRow('quotation', 'received'),
      inventoryRow('extra-form', 'maybe'),
    ]);
    delete files['forms/quotation.md'];
    const found = messages(files);
    expect(found).toContain('forms-inventory.md: duplicate form quotation');
    expect(found).toContain(
      'forms-inventory.md: status must be received or awaiting, found "maybe"',
    );
    expect(found).toContain('forms/quotation.md: required file is missing');
  });

  it('rejects a mapping row with neither spec nor gap, unknown ids, and bad row counts', () => {
    const files = validFiles();
    files['forms-inventory.md'] = table(INVENTORY_HEADER, [
      ...REQUIRED_FORMS.filter((s) => !['quotation', 'site-report', 'tax-invoice'].includes(s)).map(
        (s) => inventoryRow(s),
      ),
      inventoryRow('quotation', 'received'),
      inventoryRow('site-report', 'awaiting'),
      inventoryRow('tax-invoice', 'received'),
    ]);
    files['forms/quotation.md'] = table(MAPPING_HEADER, [
      ['A', 'x', 'y', '', ''],
      ['B', 'x', 'y', 'P9-99', ''],
      ['C', 'x', 'y', 'GAP-77', ''],
    ]);
    files['forms/site-report.md'] = table(MAPPING_HEADER, [['A', 'x', 'y', 'P1-08', '']]);
    const found = messages(files);
    expect(found).toContain('forms/quotation.md: owning spec must name a spec id or a GAP id');
    expect(found).toContain('forms/quotation.md: unknown spec id P9-99');
    expect(found).toContain('forms/quotation.md: unknown gap GAP-77');
    expect(found).toContain(
      'forms/site-report.md: form is awaiting a sample, so the mapping must have no rows',
    );
    expect(found).toContain(
      'forms/tax-invoice.md: form is received, so the mapping needs at least one row',
    );
  });

  it('rejects wrong table columns and missing files', () => {
    const files = validFiles();
    files['forms-inventory.md'] = table(['form', 'status'], []);
    delete files['gaps.md'];
    delete files['glossary.md'];
    delete files['workflows/demolition-job.md'];
    const found = messages(files);
    expect(found.some((m) => m.startsWith('forms-inventory.md: table with columns'))).toBe(true);
    expect(found).toContain('gaps.md: required file is missing');
    expect(found).toContain('glossary.md: required file is missing');
    expect(found).toContain('workflows/demolition-job.md: required file is missing');
  });

  it('rejects invalid and duplicate gap entries and an empty glossary', () => {
    const files = validFiles();
    files['gaps.md'] = table(GAPS_HEADER, [
      ['bad', 'f', 'quotation', 'P1-08', ''],
      ['GAP-01', 'f', 'quotation', 'P1-08', ''],
      ['GAP-01', 'f', 'quotation', 'P1-08', ''],
    ]);
    files['glossary.md'] = table(GLOSSARY_HEADER, []);
    const found = messages(files);
    expect(found).toContain('gaps.md: invalid gap id "bad"');
    expect(found).toContain('gaps.md: duplicate gap id GAP-01');
    expect(found).toContain('glossary.md: glossary has no terms');
  });

  it('rejects a workflow with no steps or a step that maps to no spec', () => {
    const files = validFiles();
    files['workflows/site-daily-cycle.md'] = table(WORKFLOW_HEADER, []);
    files['workflows/demolition-job.md'] = table(WORKFLOW_HEADER, [
      ['1', 'Actor', 'Doc', 'None', 'P9-99'],
      ['2', 'Actor', 'Doc', 'None', 'later'],
    ]);
    const found = messages(files);
    expect(found).toContain('workflows/site-daily-cycle.md: workflow has no steps');
    expect(found).toContain('workflows/demolition-job.md: unknown spec id P9-99');
    expect(found).toContain('workflows/demolition-job.md: spec must name a spec id');
  });

  it('reports short rows instead of crashing', () => {
    const files = validFiles();
    files['forms-inventory.md'] += '| short |\n';
    files['gaps.md'] = table(GAPS_HEADER, [['GAP-01']]);
    files['workflows/demolition-job.md'] += '| 2 |\n';
    const found = messages(files);
    expect(found).toContain('forms-inventory.md: spec must name a spec id');
    expect(found).toContain('forms-inventory.md: status must be received or awaiting, found ""');
    expect(found).toContain('workflows/demolition-job.md: spec must name a spec id');
  });

  it('rejects a broken relative link with its line number', () => {
    const files = validFiles();
    files['glossary.md'] += '\nSee [missing](forms/nope.md) and [out](../../nope.md).\n';
    const issues = checkDiscovery(input(files));
    expect(issues.filter((i) => i.message.startsWith('broken link')).map((i) => i.message)).toEqual(
      ['broken link: forms/nope.md', 'broken link: ../../nope.md'],
    );
    expect(issues.every((i) => i.line > 0)).toBe(true);
  });

  it('resolves links from nested files relative to their folder', () => {
    const files = validFiles();
    files['workflows/site-daily-cycle.md'] += '\n[ok](../glossary.md) [bad](../glossary-x.md)\n';
    const found = messages(files);
    expect(found).toEqual(['workflows/site-daily-cycle.md: broken link: ../glossary-x.md']);
  });
});

describe('real-data detection (T-3)', () => {
  it.each([
    ['CNIC with dashes', 'Client 35202-1234567-1'],
    ['CNIC without dashes', 'Client 3520212345671'],
    ['mobile with 0', 'Phone 0300-1234567'],
    ['mobile with +92', 'Phone +92 300 1234567'],
    ['mobile run together', 'Phone 03001234567'],
  ])('fails on %s', (_name, line) => {
    const files = validFiles();
    files['glossary.md'] += `\n${line}\n`;
    const found = messages(files);
    expect(found.some((m) => m.includes('looks like a real'))).toBe(true);
  });

  it('names the file and line, and ignores long numbers and amounts that are not identifiers', () => {
    const files = validFiles();
    files['glossary.md'] += '\nAmount 1,250,000 and order 12345678901234567\n';
    expect(messages(files)).toEqual([]);
    files['glossary.md'] += '\nPhone 0300-1234567\n';
    const issue = checkDiscovery(input(files)).find((i) => i.message.includes('mobile'));
    expect(issue?.file).toBe('glossary.md');
    expect(issue?.line).toBeGreaterThan(1);
  });
});
