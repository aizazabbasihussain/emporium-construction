import { describe, expect, it } from 'vitest';
import { RuleViolationError, ValidationError } from '../errors.js';
import { lineKinds } from './costing.js';
import {
  assertCostCodeKind,
  assertEditable,
  assertLockable,
  assertSalvageAllowed,
  assertTemplateFormula,
  assertTemplateParameters,
  assertTransition,
  estimateStatuses,
  estimateTransitions,
} from './rules.js';

describe('estimate state machine (spec P1-07 T-5)', () => {
  const allowed = new Set(['draft>locked', 'locked>superseded']);

  for (const from of estimateStatuses) {
    for (const to of estimateStatuses) {
      const ok = allowed.has(`${from}>${to}`);
      it(`${from} to ${to} is ${ok ? 'allowed' : 'forbidden'}`, () => {
        if (ok) expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrow(RuleViolationError);
      });
    }
  }

  it('lists exactly the allowed transitions', () => {
    expect(Object.values(estimateTransitions).flat()).toHaveLength(allowed.size);
  });

  it('only a draft can be edited', () => {
    expect(() => assertEditable('draft')).not.toThrow();
    expect(() => assertEditable('locked')).toThrow(RuleViolationError);
    expect(() => assertEditable('superseded')).toThrow(RuleViolationError);
  });
});

describe('lock rule (BR-3)', () => {
  it('blocks locking while a company line has no rate', () => {
    expect(() =>
      assertLockable([
        { rate: '5', suppliedBy: 'company' },
        { rate: '0', suppliedBy: 'company' },
      ]),
    ).toThrow(RuleViolationError);
    expect(() =>
      assertLockable([
        { rate: '5', suppliedBy: 'company' },
        { rate: '0', suppliedBy: 'client' },
      ]),
    ).not.toThrow();
    expect(() => assertLockable([])).not.toThrow();
  });
});

describe('salvage rule (BR-9, spec P1-07 T-6)', () => {
  it('allows salvage credits only for demolition and restructure', () => {
    expect(() => assertSalvageAllowed('demolition', 'salvage_credit')).not.toThrow();
    expect(() => assertSalvageAllowed('restructure', 'salvage_credit')).not.toThrow();
    expect(() => assertSalvageAllowed('boundary_wall', 'salvage_credit')).toThrow(ValidationError);
    expect(() => assertSalvageAllowed('boundary_wall', 'material')).not.toThrow();
  });
});

describe('cost code kind rule (BR-11, spec P1-07 T-6)', () => {
  const expected: Record<string, string[]> = {
    material: ['material'],
    labour: ['labour'],
    subcontract: ['subcontract'],
    equipment: ['equipment'],
    disposal: ['overhead', 'subcontract'],
    salvage_credit: ['overhead', 'subcontract'],
  };
  const codeKinds = ['material', 'labour', 'subcontract', 'equipment', 'overhead'];

  for (const kind of lineKinds) {
    for (const codeKind of codeKinds) {
      const ok = expected[kind]?.includes(codeKind) === true;
      it(`${kind} line with a ${codeKind} code is ${ok ? 'accepted' : 'rejected'}`, () => {
        if (ok) expect(() => assertCostCodeKind(kind, codeKind)).not.toThrow();
        else expect(() => assertCostCodeKind(kind, codeKind)).toThrow(ValidationError);
      });
    }
  }
});

describe('template checks', () => {
  const parameters = [
    { key: 'length', label: 'Length', unit: 'ft' },
    { key: 'height', label: 'Height', unit: 'ft' },
  ];

  it('accepts distinct lower-case parameter keys', () => {
    expect(() => assertTemplateParameters(parameters)).not.toThrow();
    expect(() => assertTemplateParameters([])).not.toThrow();
  });

  it('rejects bad, reserved and repeated keys', () => {
    const bad = (key: string) => [{ key, label: 'x', unit: 'u' }];
    expect(() => assertTemplateParameters(bad('Length'))).toThrow(ValidationError);
    expect(() => assertTemplateParameters(bad('1a'))).toThrow(ValidationError);
    expect(() => assertTemplateParameters(bad('max'))).toThrow(ValidationError);
    expect(() => assertTemplateParameters([...parameters, ...parameters])).toThrow(ValidationError);
  });

  it('accepts a formula over the declared parameters and rejects others', () => {
    expect(() => assertTemplateFormula('ceil(length * height / 50)', parameters)).not.toThrow();
    expect(() => assertTemplateFormula('12', parameters)).not.toThrow();
    expect(() => assertTemplateFormula('length * width', parameters)).toThrow(ValidationError);
    expect(() => assertTemplateFormula('length *', parameters)).toThrow(ValidationError);
  });
});
