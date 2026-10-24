import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { errorsCsv, parseFile, parseXlsx } from './files.service.js';
import { createStagingStore } from './staging.service.js';

describe('parseXlsx cell conversion', () => {
  it('reads hyperlinks, error cells and empty cells as text', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('S');
    sheet.addRow(['A', 'B', 'C', 'D', 'E']);
    sheet.addRow([
      { text: 'site', hyperlink: 'https://example.test' },
      { error: '#N/A' },
      true,
      null,
      12,
    ]);
    const rows = await parseXlsx(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(rows).toEqual([
      ['A', 'B', 'C', 'D', 'E'],
      ['site', '', 'true', '', '12'],
    ]);
  });

  it('dispatches by format', async () => {
    expect(await parseFile('csv', Buffer.from('﻿a,b\n1,2'))).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('errorsCsv', () => {
  it('starts with a byte-order mark and quotes awkward messages', () => {
    const text = errorsCsv([{ rowNo: 3, column: 'Name', message: 'Bad, "value"' }]);
    expect(text).toBe('﻿row,column,message\r\n3,Name,"Bad, ""value"""\r\n');
  });
});

describe('staging store', () => {
  it('keeps, returns and discards rows and evicts the oldest over capacity', () => {
    const store = createStagingStore(2);
    store.put('a', [1]);
    store.put('b', [2]);
    expect(store.take('a')).toEqual([1]);
    store.put('c', [3]);
    expect(store.size()).toBe(2);
    expect(store.take('a')).toBeUndefined();
    store.discard('b');
    expect(store.take('b')).toBeUndefined();
    expect(store.size()).toBe(1);
  });
});
