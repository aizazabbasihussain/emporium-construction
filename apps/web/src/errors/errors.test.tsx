import { notification } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../admin/api';
import { fieldErrorsOf, fieldProps } from './fieldErrors';
import { describeIssue, summarizeIssues, type ApiIssue } from './issues';
import { notifyError } from './notify';

// The answer the template editor got for a line with an empty description and formula.
const issues: ApiIssue[] = [
  {
    origin: 'string',
    code: 'too_small',
    minimum: 1,
    inclusive: true,
    path: ['lines', 0, 'description'],
    message: 'Too small: expected string to have >=1 characters',
  },
  {
    origin: 'string',
    code: 'too_small',
    minimum: 1,
    inclusive: true,
    path: ['lines', 0, 'qtyFormula'],
    message: 'Too small: expected string to have >=1 characters',
  },
];
const failure = new ApiError(400, 'validation_failed', 'x', issues, 'req-1');

afterEach(() => {
  notification.destroy();
  vi.restoreAllMocks();
});

describe('describeIssue', () => {
  it('names the row and the field', () => {
    expect(describeIssue(issues[0] as ApiIssue)).toBe('Line 1 - Description is required');
    expect(describeIssue(issues[1] as ApiIssue)).toBe('Line 1 - Quantity formula is required');
  });

  it('words each kind of check', () => {
    const text = (issue: ApiIssue) => describeIssue({ path: ['rate'], ...issue });
    expect(text({ code: 'too_small', origin: 'string', minimum: 3 })).toBe(
      'Rate must be at least 3 characters',
    );
    expect(text({ code: 'too_small', origin: 'number', minimum: 0, inclusive: true })).toBe(
      'Rate must be at least 0',
    );
    expect(text({ code: 'too_small', origin: 'number', minimum: 0, inclusive: false })).toBe(
      'Rate must be greater than 0',
    );
    expect(text({ code: 'too_small', origin: 'array', minimum: 1 })).toBe(
      'Rate needs at least 1 entry',
    );
    expect(text({ code: 'too_big', origin: 'string', maximum: 5 })).toBe(
      'Rate must be at most 5 characters',
    );
    expect(text({ code: 'too_big', origin: 'number', maximum: 9, inclusive: true })).toBe(
      'Rate must be at most 9',
    );
    expect(text({ code: 'too_big', origin: 'array', maximum: 2 })).toBe(
      'Rate can have at most 2 entries',
    );
    expect(text({ code: 'invalid_type', message: 'expected string, received undefined' })).toBe(
      'Rate is required',
    );
    expect(text({ code: 'invalid_type', message: 'expected number, received string' })).toBe(
      'Rate is not valid',
    );
    expect(text({ code: 'invalid_format' })).toBe('Rate has an invalid format');
    expect(text({ code: 'invalid_value' })).toBe('Rate is not one of the allowed values');
    expect(text({ code: 'custom', message: 'Must match the quote' })).toBe(
      'Rate: Must match the quote',
    );
    expect(text({ code: 'custom' })).toBe('Rate is not valid');
  });

  it('falls back to the key for unlisted fields and handles nested and empty paths', () => {
    expect(describeIssue({ code: 'invalid_format', path: ['gstNumber'] })).toBe(
      'Gst number has an invalid format',
    );
    expect(describeIssue({ code: 'invalid_format', path: ['address', 'city'] })).toBe(
      'Address - City has an invalid format',
    );
    expect(describeIssue({ code: 'invalid_format', path: ['lines', 2] })).toBe(
      'Line 3 has an invalid format',
    );
    expect(describeIssue({ code: 'invalid_format' })).toBe('Name has an invalid format');
  });
});

describe('summarizeIssues', () => {
  it('replaces "Request validation failed" with the problems', () => {
    expect(summarizeIssues(issues)).toBe(
      'Check the form: Line 1 - Description is required; Line 1 - Quantity formula is required',
    );
  });

  it('shortens a long list', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      ...issues[0],
      path: ['lines', i, 'code'],
    }));
    expect(summarizeIssues(many as ApiIssue[])).toContain('; 2 more');
  });
});

describe('field errors', () => {
  it('keys the first problem of each field by its path', () => {
    expect(fieldErrorsOf(failure)).toEqual({
      'lines.0.description': 'Line 1 - Description is required',
      'lines.0.qtyFormula': 'Line 1 - Quantity formula is required',
    });
    expect(fieldErrorsOf(new Error('x'))).toEqual({});
    expect(fieldErrorsOf(new ApiError(500, 'boom', 'x'))).toEqual({});
  });

  it('marks only the failed controls', () => {
    const errors = fieldErrorsOf(failure);
    expect(fieldProps(errors, 'lines', 0, 'description')).toMatchObject({
      status: 'error',
      'aria-invalid': true,
    });
    expect(fieldProps(errors, 'lines', 1, 'description')).toEqual({});
  });
});

describe('notifyError', () => {
  it('lists every field problem in a red pop-up', () => {
    const spy = vi.spyOn(notification, 'error').mockImplementation(() => undefined);
    notifyError(failure);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ placement: 'topRight', title: 'Fix 2 problems and save again' }),
    );
  });

  it('shows the server message for other answers and a hint when offline', () => {
    const spy = vi.spyOn(notification, 'error').mockImplementation(() => undefined);
    notifyError(new ApiError(409, 'conflict', 'Someone else changed this record'));
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: 'Someone else changed this record' }),
    );
    notifyError(new TypeError('Failed to fetch'));
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        description: 'Cannot reach the server. Check your connection and try again.',
      }),
    );
    notifyError(new Error('not a request error'));
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
