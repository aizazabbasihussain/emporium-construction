import {
  GAPS_HEADER,
  GLOSSARY_HEADER,
  INVENTORY_HEADER,
  MAPPING_HEADER,
  REQUIRED_FORMS,
  REQUIRED_WORKFLOWS,
  WORKFLOW_HEADER,
} from '../src/check.ts';

export const table = (header: string[], rows: string[][]): string =>
  [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n') + '\n';

export function inventoryRow(slug: string, status = 'awaiting', spec = 'P1-08'): string[] {
  return [`[${slug}](forms/${slug}.md)`, slug, 'Clerk', 'Daily', '2', 'Owner', spec, status];
}

/** A complete, valid discovery pack where every form is awaiting a sample. */
export function validFiles(): Record<string, string> {
  const files: Record<string, string> = {
    'forms-inventory.md': table(
      INVENTORY_HEADER,
      REQUIRED_FORMS.map((slug) => inventoryRow(slug)),
    ),
    'gaps.md': table(GAPS_HEADER, []),
    'glossary.md': table(GLOSSARY_HEADER, [['Cement', 'cement-urdu', 'seemant', '']]),
  };
  for (const slug of REQUIRED_FORMS) files[`forms/${slug}.md`] = table(MAPPING_HEADER, []);
  for (const name of REQUIRED_WORKFLOWS) {
    files[`workflows/${name}.md`] = table(WORKFLOW_HEADER, [
      ['1. Quote', 'Estimator', 'Quotation', 'Owner', 'P1-08'],
    ]);
  }
  return files;
}
