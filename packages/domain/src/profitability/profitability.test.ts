import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors.js';
import {
  alertChanges,
  assertThresholds,
  compareRisk,
  computeFinancials,
  costToComplete,
  daysBetween,
  evaluateAlerts,
  percentOf,
  pickThresholds,
  type FinancialsInput,
} from './index.js';

/** The worksheet of the scripted project (spec T-1), every figure worked out by hand. */
const scripted: FinancialsInput = {
  contractValue: '1100000.00', // 1,000,000 original + 100,000 variation
  billed: { base: '800000.00', tax: '144000.00', gross: '944000.00' },
  collected: { gross: '590000.00', withheld: '20000.00', base: '500000.00' },
  cost: { committed: '100000.00', approved: '200000.00', posted: '300000.00', budget: '900000.00' },
  paidOut: { vendors: '250000.00', wages: '120000.00', expenses: '10000.00' },
  forecast: null,
};

describe('percentOf (BR-7)', () => {
  it('rounds half-up to 2 decimals', () => {
    expect(percentOf('1', '3')).toBe('33.33');
    expect(percentOf('2', '3')).toBe('66.67');
    expect(percentOf('1', '8')).toBe('12.50');
    expect(percentOf('1.00', '16')).toBe('6.25');
    expect(percentOf('1', '16000')).toBe('0.01'); // 0.00625 rounds half-up
    expect(percentOf('-1', '3')).toBe('-33.33');
  });
  it('is null when the base is zero', () => {
    expect(percentOf('5', '0')).toBeNull();
    expect(percentOf('0', '0.00')).toBeNull();
  });
});

describe('costToComplete (BR-2)', () => {
  it('uses the manual forecast when one is set', () => {
    expect(costToComplete('50000', '900000', '600000')).toEqual({
      amount: '50000.00',
      source: 'forecast',
    });
    expect(costToComplete('0', '900000', '600000').amount).toBe('0.00');
  });
  it('else the budget not yet used', () => {
    expect(costToComplete(null, '900000', '600000')).toEqual({
      amount: '300000.00',
      source: 'budget',
    });
  });
  it('never goes below zero', () => {
    expect(costToComplete(null, '900000', '950000').amount).toBe('0.00');
    expect(costToComplete(null, '0', '0').amount).toBe('0.00');
  });
});

describe('computeFinancials (T-1, T-2)', () => {
  it('matches the worksheet to the paisa without a forecast', () => {
    expect(computeFinancials(scripted)).toEqual({
      contractValue: '1100000.00',
      billedBase: '800000.00',
      billedTax: '144000.00',
      billedGross: '944000.00',
      billedPercent: '72.73',
      collectedGross: '590000.00',
      collectedBase: '500000.00',
      withheldTax: '20000.00',
      collectedPercent: '45.45',
      outstandingReceivable: '354000.00',
      committed: '100000.00',
      approved: '200000.00',
      posted: '300000.00',
      costToDate: '600000.00',
      budget: '900000.00',
      costPercentOfBudget: '66.67',
      costToComplete: '300000.00',
      costToCompleteSource: 'budget',
      expectedMargin: '200000.00',
      expectedMarginPercent: '18.18',
      currentMargin: '300000.00',
      currentMarginPercent: '37.50',
      paidOutVendors: '250000.00',
      paidOutWages: '120000.00',
      paidOutExpenses: '10000.00',
      paidOut: '380000.00',
      cashPosition: '210000.00',
    });
  });

  it('uses the forecast for the expected margin and leaves the current margin alone', () => {
    const result = computeFinancials({ ...scripted, forecast: '100000' });
    expect(result.costToComplete).toBe('100000.00');
    expect(result.costToCompleteSource).toBe('forecast');
    expect(result.expectedMargin).toBe('400000.00'); // 1,100,000 - 600,000 - 100,000
    expect(result.expectedMarginPercent).toBe('36.36');
    expect(result.currentMargin).toBe('300000.00');
  });

  it('gives null percents, not errors, for zero budget, zero billed and zero contract', () => {
    const empty = computeFinancials({
      contractValue: '0',
      billed: { base: '0', tax: '0', gross: '0' },
      collected: { gross: '0', withheld: '0', base: '0' },
      cost: { committed: '0', approved: '0', posted: '0', budget: '0' },
      paidOut: { vendors: '0', wages: '0', expenses: '0' },
      forecast: null,
    });
    expect(empty.billedPercent).toBeNull();
    expect(empty.collectedPercent).toBeNull();
    expect(empty.costPercentOfBudget).toBeNull();
    expect(empty.expectedMarginPercent).toBeNull();
    expect(empty.currentMarginPercent).toBeNull();
    expect(empty.costToComplete).toBe('0.00');
    expect(empty.cashPosition).toBe('0.00');
  });

  it('shows a negative cash position when the company funded the project', () => {
    const funded = computeFinancials({
      ...scripted,
      collected: { gross: '100000', withheld: '0', base: '84745.76' },
    });
    expect(funded.cashPosition).toBe('-280000.00');
  });
});

describe('thresholds and alerts (BR-4)', () => {
  const thresholds = { marginFloorPercent: '10', overspendPercent: '100', receivableAgeDays: 30 };
  const base: { expectedMarginPercent: string | null; costPercentOfBudget: string | null } = {
    expectedMarginPercent: '20.00',
    costPercentOfBudget: '80.00',
  };

  it('prefers the project thresholds over the company ones', () => {
    const rows = [
      { scope: 'company', projectId: null, id: 'c' },
      { scope: 'project', projectId: 'p1', id: 'p' },
      { scope: 'project', projectId: 'p2', id: 'other' },
    ];
    expect(pickThresholds(rows, 'p1')?.id).toBe('p');
    expect(pickThresholds(rows, 'p3')?.id).toBe('c');
    expect(pickThresholds([rows[1] as (typeof rows)[number]], 'p3')).toBeNull();
  });

  it('counts days between business dates', () => {
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
    expect(daysBetween('2026-10-31', '2026-10-01')).toBe(-30);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });

  it('raises nothing without thresholds or when every condition is fine', () => {
    expect(
      evaluateAlerts({
        financials: { expectedMarginPercent: '-50', costPercentOfBudget: '500' },
        thresholds: null,
        oldestDueDate: '2020-01-01',
        asOf: '2026-10-31',
      }),
    ).toEqual([]);
    expect(
      evaluateAlerts({ financials: base, thresholds, oldestDueDate: null, asOf: '2026-10-31' }),
    ).toEqual([]);
  });

  it('raises each condition when it is crossed, and not at the limit', () => {
    const at = (over: Partial<typeof base>, due: string | null) =>
      evaluateAlerts({
        financials: { ...base, ...over },
        thresholds,
        oldestDueDate: due,
        asOf: '2026-10-31',
      });
    expect(at({ expectedMarginPercent: '9.99' }, null)).toEqual(['margin_below_floor']);
    expect(at({ expectedMarginPercent: '10.00' }, null)).toEqual([]);
    expect(at({ expectedMarginPercent: null }, null)).toEqual([]);
    expect(at({ costPercentOfBudget: '100.01' }, null)).toEqual(['overspend']);
    expect(at({ costPercentOfBudget: '100.00' }, null)).toEqual([]);
    expect(at({ costPercentOfBudget: null }, null)).toEqual([]);
    expect(at({}, '2026-09-30')).toEqual(['receivable_overdue']); // 31 days
    expect(at({}, '2026-10-01')).toEqual([]); // exactly 30 days
    expect(at({ expectedMarginPercent: '1', costPercentOfBudget: '150' }, '2026-01-01')).toEqual([
      'margin_below_floor',
      'overspend',
      'receivable_overdue',
    ]);
  });

  it('raises once and clears when the condition is gone, with no duplicates', () => {
    expect(alertChanges([], ['overspend'])).toEqual({ raise: ['overspend'], clear: [] });
    expect(alertChanges(['overspend'], ['overspend'])).toEqual({ raise: [], clear: [] });
    expect(alertChanges(['overspend', 'margin_below_floor'], ['margin_below_floor'])).toEqual({
      raise: [],
      clear: ['overspend'],
    });
  });

  it('validates the thresholds', () => {
    expect(() => assertThresholds({ ...thresholds })).not.toThrow();
    for (const bad of [
      { ...thresholds, marginFloorPercent: 'x' },
      { ...thresholds, marginFloorPercent: '101' },
      { ...thresholds, marginFloorPercent: '-1' },
      { ...thresholds, overspendPercent: '1001' },
      { ...thresholds, overspendPercent: '1.23456' },
      { ...thresholds, receivableAgeDays: -1 },
      { ...thresholds, receivableAgeDays: 1.5 },
    ]) {
      expect(() => assertThresholds(bad)).toThrow(ValidationError);
    }
  });
});

describe('compareRisk (BR-5)', () => {
  const row = (alerts: number, margin: string | null, cash: string) => ({
    alerts,
    expectedMarginPercent: margin,
    cashPosition: cash,
  });
  it('puts more alerts first, then the lower margin, then the lower cash', () => {
    const rows = [
      row(0, '30.00', '100'),
      row(2, '50.00', '100'),
      row(0, '10.00', '100'),
      row(0, null, '100'),
      row(0, '10.00', '-5'),
      row(1, '90.00', '100'),
    ];
    expect([...rows].sort(compareRisk)).toEqual([
      row(2, '50.00', '100'),
      row(1, '90.00', '100'),
      row(0, '10.00', '-5'),
      row(0, '10.00', '100'),
      row(0, '30.00', '100'),
      row(0, null, '100'),
    ]);
    expect(compareRisk(row(0, null, '1'), row(0, '5.00', '1'))).toBe(1);
    expect(compareRisk(row(0, '5.00', '1'), row(0, null, '1'))).toBe(-1);
    expect(compareRisk(row(0, null, '1'), row(0, null, '1'))).toBe(0);
  });
});
