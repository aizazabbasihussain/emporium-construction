import { buildPrintModel, deriveStages } from '@emporium/domain/quotations';
import { describe, expect, it } from 'vitest';
import { pdfLines, renderQuotationPdf } from './pdf.js';

const model = (
  over: { scope?: string; stages?: number; client?: Partial<{ address: string | null }> } = {},
) => {
  const count = over.stages ?? 2;
  return buildPrintModel({
    company: { name: 'Synthetic Construction', address: 'Islamabad', phone: '051', email: null },
    registrations: [{ authority: 'FBR', registrationType: 'ntn', number: 'SYN-1' }],
    client: {
      name: 'A (Client) \\ with ünï©ode ☃',
      address: over.client?.address ?? 'Street 1',
      city: 'Lahore',
    },
    quotation: {
      number: 'QUO-2026-0001/2',
      revision: 2,
      title: 'Boundary wall',
      issuedOn: '2026-10-25',
      expiresOn: '2026-11-24',
      validityDays: 30,
      scopeText: over.scope ?? 'Build a wall',
      inclusions: 'Materials',
      exclusions: '',
      terms: 'Net 7 days',
      price: '1000.00',
    },
    stages: deriveStages(
      '1000.00',
      Array.from({ length: count }, (_, i) => ({
        name: `Stage ${i + 1}`,
        basis: 'percent' as const,
        percent:
          i === count - 1
            ? String(100 - Math.floor(100 / count) * (count - 1))
            : String(Math.floor(100 / count)),
        conditionText: i === 0 ? 'On signing' : null,
      })),
    ),
  });
};

describe('quotation PDF (BR-9)', () => {
  it('draws the print model: company, client, schedule and price, no internal figures', () => {
    const text = pdfLines(model())
      .map((l) => l.text)
      .join('\n');
    expect(text).toContain('Synthetic Construction');
    expect(text).toContain('FBR NTN: SYN-1');
    expect(text).toContain('Quotation QUO-2026-0001/2');
    expect(text).toContain('Valid until: 2026-11-24');
    expect(text).toContain('1. Stage 1 - 50.0000% - PKR 500.00');
    expect(text).toContain('On signing');
    expect(text).toContain('Total price: PKR 1,000.00 (excluding tax)');
    expect(text).not.toContain('Exclusions');
    expect(text).not.toMatch(/margin|cost/i);
  });

  it('produces a well-formed PDF with escaped text and a correct cross-reference table', () => {
    const bytes = renderQuotationPdf(model());
    const text = bytes.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('A \\(Client\\) \\\\ with');
    expect(text).toContain('?');
    const startxref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((offset, i) => {
      expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
  });

  it('wraps long text and flows onto more pages', () => {
    const long = 'word '.repeat(2000);
    const bytes = renderQuotationPdf(model({ scope: long, stages: 4, client: { address: null } }));
    const text = bytes.toString('latin1');
    expect(Number(/\/Count (\d+)/.exec(text)?.[1])).toBeGreaterThan(1);
    expect(pdfLines(model({ scope: 'a\nb\n\nc' })).map((l) => l.text)).toContain('b');
  });
});
