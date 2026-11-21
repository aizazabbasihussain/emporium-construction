import { formatAmount } from '@emporium/shared';
import type { PayslipDto } from '../types.js';

interface TextLine {
  text: string;
  size: number;
  bold: boolean;
}

const PAGE = { width: 595, height: 842, margin: 50 };

/** Standard PDF fonts cover Latin-1 only; other characters print as a question mark. */
const pdfText = (text: string): string =>
  text.replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/([\\()])/g, '\\$1');

const pkr = (amount: string) => `PKR ${formatAmount(amount)}`;

/** The text of one payslip, top to bottom (BR-3: only the worker's own figures). */
export function payslipLines(slip: PayslipDto): TextLine[] {
  const lines: TextLine[] = [];
  const add = (text: string, size = 10, bold = false) => lines.push({ text, size, bold });
  add(`Payslip ${slip.number}`, 14, true);
  add(`Month: ${slip.period}`);
  add(`Worker: ${slip.workerName} (${slip.workerCode})`);
  add(`Pay basis: ${slip.payBasis}`);
  if (slip.rate !== null) add(`Rate: ${pkr(slip.rate)}`);
  add('');
  add('Attendance', 11, true);
  add(`Present days: ${slip.attendance.presentDays}   Half days: ${slip.attendance.halfDays}`);
  add(
    `Paid leave: ${slip.attendance.paidLeaveDays}   Off days: ${slip.attendance.offDays}   Absent: ${slip.attendance.absentDays}`,
  );
  add(`Overtime hours: ${slip.attendance.overtimeHours}`);
  add('');
  add('Pay', 11, true);
  add(`Basic pay: ${pkr(slip.basicPay)}`);
  add(`Overtime: ${pkr(slip.overtimePay)}`);
  add(`Allowances: ${pkr(slip.allowances)}`);
  add(`Deductions: ${pkr(slip.deductions)}`);
  add(`Advance recovery: ${pkr(slip.advanceRecovery)}`);
  add(`Net pay: ${pkr(slip.netPay)}`, 12, true);
  return lines;
}

/** A small text-only PDF 1.4 (Helvetica, A4), one page per payslip, so the module needs no PDF library. */
export function renderPayslipsPdf(slips: readonly PayslipDto[]): Buffer {
  const pages = slips.map((slip) => payslipLines(slip));
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
