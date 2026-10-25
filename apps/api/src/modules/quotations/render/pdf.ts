import { formatAmount } from '@emporium/shared';
import type { QuotationPrintModel } from '../types.js';

interface TextLine {
  text: string;
  size: number;
  bold: boolean;
}

const PAGE = { width: 595, height: 842, margin: 50 };
const WRAP_AT = 88;

/** Standard PDF fonts cover Latin-1 only; other characters print as a question mark. */
const pdfText = (text: string): string =>
  text.replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/([\\()])/g, '\\$1');

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let current = '';
    for (const word of paragraph.split(/\s+/).filter((w) => w !== '')) {
      if (current !== '' && current.length + 1 + word.length > width) {
        lines.push(current);
        current = word;
      } else {
        current = current === '' ? word : `${current} ${word}`;
      }
    }
    lines.push(current);
  }
  return lines;
}

/** The text of the document, top to bottom (BR-9: this is built from the print model only). */
export function pdfLines(model: QuotationPrintModel): TextLine[] {
  const lines: TextLine[] = [];
  const add = (text: string, size = 10, bold = false) => {
    for (const part of wrap(text, size > 12 ? 60 : WRAP_AT)) lines.push({ text: part, size, bold });
  };
  const gap = () => lines.push({ text: '', size: 10, bold: false });
  const section = (title: string, body: string) => {
    if (body.trim() === '') return;
    gap();
    add(title, 11, true);
    add(body);
  };

  add(model.company.name, 16, true);
  for (const part of [model.company.address, model.company.phone, model.company.email]) {
    if (part !== null) add(part);
  }
  for (const r of model.registrations)
    add(`${r.authority} ${r.registrationType.toUpperCase()}: ${r.number}`);
  gap();
  add(`Quotation ${model.quotation.number}`, 14, true);
  add(model.quotation.title, 12, true);
  if (model.quotation.issuedOn !== null) add(`Date: ${model.quotation.issuedOn}`);
  if (model.quotation.expiresOn !== null) add(`Valid until: ${model.quotation.expiresOn}`);
  add(`Validity: ${model.quotation.validityDays} days`);
  gap();
  add('To', 11, true);
  add(model.client.name);
  for (const part of [model.client.address, model.client.city]) {
    if (part !== null) add(part);
  }
  section('Scope of work', model.scope);
  section('Inclusions', model.inclusions);
  section('Exclusions', model.exclusions);
  gap();
  add('Payment schedule', 11, true);
  for (const stage of model.stages) {
    add(`${stage.stageNo}. ${stage.name} - ${stage.percent}% - PKR ${formatAmount(stage.amount)}`);
    if (stage.condition !== null) add(`   ${stage.condition}`);
  }
  section('Terms', model.terms);
  gap();
  add(`Total price: PKR ${formatAmount(model.price)} (excluding tax)`, 12, true);
  return lines;
}

/** A small text-only PDF 1.4 (Helvetica, A4) so the module needs no PDF library. */
export function renderQuotationPdf(model: QuotationPrintModel): Buffer {
  const pages: TextLine[][] = [[]];
  let y = PAGE.height - PAGE.margin;
  for (const line of pdfLines(model)) {
    const step = line.size + 4;
    if (y - step < PAGE.margin) {
      pages.push([]);
      y = PAGE.height - PAGE.margin;
    }
    y -= step;
    (pages[pages.length - 1] as TextLine[]).push(line);
  }

  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((page, index) => {
    let top = PAGE.height - PAGE.margin;
    const content = page
      .map((line) => {
        top -= line.size + 4;
        return `BT /${line.bold ? 'F2' : 'F1'} ${line.size} Tf ${PAGE.margin} ${top} Td (${pdfText(line.text)}) Tj ET`;
      })
      .join('\n');
    const pageId = pageIds[index] as number;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] =
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
