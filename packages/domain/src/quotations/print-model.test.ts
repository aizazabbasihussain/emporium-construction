import { describe, expect, it } from 'vitest';
import { buildPrintModel, type QuotationPrintModel } from './print-model.js';
import { deriveStages } from './stages.js';

const stages = deriveStages('1000.00', [
  { name: 'Advance', basis: 'percent', percent: '30', conditionText: 'On signing' },
  { name: 'Handover', basis: 'percent', percent: '70' },
]);

// The source carries extra internal fields on purpose: the model must not copy them.
const source = {
  number: 'QUO-2026-0001',
  revision: 2,
  title: 'Boundary wall',
  issuedOn: '2026-10-25',
  expiresOn: '2026-11-24',
  validityDays: 30,
  scopeText: 'Build a wall',
  inclusions: 'Materials',
  exclusions: 'Painting',
  terms: 'Net 7 days',
  price: '1000.00',
  totalCost: '850.00',
  marginPercent: '15.0000',
};

const model = (): QuotationPrintModel =>
  buildPrintModel({
    company: { name: 'Emporium', address: 'Islamabad', phone: null, email: null },
    registrations: [{ authority: 'FBR', registrationType: 'ntn', number: '1234567-8' }],
    client: { name: 'A Client', address: null, city: 'Lahore' },
    quotation: source,
    stages,
  });

describe('quotation print model (spec P1-08 T-7, BR-8, BR-9)', () => {
  it('pins the model (golden)', () => {
    expect(model()).toEqual({
      company: { name: 'Emporium', address: 'Islamabad', phone: null, email: null },
      registrations: [{ authority: 'FBR', registrationType: 'ntn', number: '1234567-8' }],
      client: { name: 'A Client', address: null, city: 'Lahore' },
      quotation: {
        number: 'QUO-2026-0001',
        revision: 2,
        title: 'Boundary wall',
        issuedOn: '2026-10-25',
        expiresOn: '2026-11-24',
        validityDays: 30,
      },
      scope: 'Build a wall',
      inclusions: 'Materials',
      exclusions: 'Painting',
      stages: [
        {
          stageNo: 1,
          name: 'Advance',
          percent: '30.0000',
          amount: '300.00',
          condition: 'On signing',
        },
        { stageNo: 2, name: 'Handover', percent: '70.0000', amount: '700.00', condition: null },
      ],
      terms: 'Net 7 days',
      price: '1000.00',
      priceNote: 'excluding_tax',
    });
  });

  it('has no field name that could carry internal cost or margin', () => {
    const names: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          names.push(key);
          walk(inner);
        }
      }
    };
    walk(model());
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((name) => /cost|margin|overhead|contingency|profit/i.test(name))).toEqual(
      [],
    );
    expect(JSON.stringify(model())).not.toContain('850');
  });
});
