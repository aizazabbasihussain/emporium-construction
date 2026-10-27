import { describe, expect, it } from 'vitest';
import {
  adrIds,
  checkBands,
  get,
  isoDate,
  seedFileNames,
  validateAdr,
  validateAdrs,
  validateSeeds,
  type SeedFiles,
} from './index.js';

const header: Record<string, string> = {
  'chart_of_accounts.csv': 'code,name,type,parent_code,active',
  'tax_authorities.csv': 'code,name,registration_number',
  'tax_rules.csv': 'authority,applies_to,region,rate_percent,effective_from,effective_to,note',
  'withholding_rules.csv':
    'direction,party_type,nature,rate_percent,base,effective_from,effective_to',
  'roles.csv': 'code,name',
  'role_permissions.csv': 'role_code,permission_code',
  'approval_rules.csv': 'document_type,min_amount,max_amount,steps',
  'valuation_policy.csv': 'scope,category_code,method,effective_from',
  'number_series.csv': 'code,prefix,padding,reset_yearly,gapless,start_value',
  'rounding.csv': 'context,mode,decimals',
  'cost_codes.csv': 'code,name,parent_code,kind',
};

const body = (file: string, ...rows: string[]): string => [header[file], ...rows].join('\n') + '\n';

const emptySeeds = (): Record<string, string> =>
  Object.fromEntries(seedFileNames.map((name) => [name, body(name)]));

const sample = (): Record<string, string> => ({
  ...emptySeeds(),
  'chart_of_accounts.csv': body(
    'chart_of_accounts.csv',
    '1,Assets,asset,,true',
    '11,Cash,asset,1,false',
  ),
  'tax_authorities.csv': body('tax_authorities.csv', 'AUTH,Authority,'),
  'tax_rules.csv': body(
    'tax_rules.csv',
    'AUTH,services,North,5,2026-01-01,2026-12-31,',
    'AUTH,services,North,6,2027-01-01,,',
  ),
  'withholding_rules.csv': body(
    'withholding_rules.csv',
    'we_withhold,vendor,goods,1.5,bill,2026-01-01,2026-06-30',
    'we_withhold,vendor,goods,2,bill,2026-07-01,',
  ),
  'roles.csv': body('roles.csv', 'boss,Boss', 'clerk,Clerk'),
  'role_permissions.csv': body('role_permissions.csv', 'clerk,doc.view'),
  'approval_rules.csv': body(
    'approval_rules.csv',
    'doc,0,100.50,clerk',
    'doc,100.50,,clerk|boss',
    'other,0,,boss',
  ),
  'valuation_policy.csv': body(
    'valuation_policy.csv',
    'company,,weighted_average,2026-01-01',
    'category,CAT,fifo,2026-01-01',
    'company,,fifo,2027-01-01',
  ),
  'number_series.csv': body('number_series.csv', 'a,AA,4,true,true,1', 'b,BB,5,false,false,100'),
  'rounding.csv': body('rounding.csv', 'line,half_up,2'),
  'cost_codes.csv': body('cost_codes.csv', '100,Materials,,material', '101,Sand,100,material'),
});

const messagesFor = (files: SeedFiles, file: string): string[] =>
  validateSeeds(files)
    .issues.filter((issue) => issue.file === file)
    .map((issue) => `${issue.row}: ${issue.message}`);

const withFile = (file: string, text: string): SeedFiles => ({ ...sample(), [file]: text });

describe('validateSeeds', () => {
  it('T-2 passes header-only files and reports them as pending', () => {
    const report = validateSeeds(emptySeeds());
    expect(report.issues).toEqual([]);
    expect(report.headerOnly).toEqual(seedFileNames);
  });

  it('AC-2 passes with synthetic example data', () => {
    const report = validateSeeds(sample());
    expect(report.issues).toEqual([]);
    expect(report.headerOnly).toEqual([]);
  });

  it('reports a missing file', () => {
    const files = sample();
    delete files['roles.csv'];
    expect(messagesFor(files, 'roles.csv')).toEqual(['0: file is missing']);
  });

  it('reports a wrong header, empty text and an unterminated quote', () => {
    expect(messagesFor(withFile('roles.csv', 'code,title\n'), 'roles.csv')).toEqual([
      '1: header must be exactly: code,name',
    ]);
    expect(messagesFor(withFile('roles.csv', ''), 'roles.csv')).toEqual([
      '1: header must be exactly: code,name',
    ]);
    expect(messagesFor(withFile('roles.csv', 'code,name\n"a,b\n'), 'roles.csv')).toEqual([
      '0: The CSV file has an unterminated quote',
    ]);
  });

  it('reports a row with the wrong number of columns and skips blank lines', () => {
    const text = 'code,name\n\nboss,Boss,extra\nclerk,Clerk\n';
    expect(messagesFor(withFile('roles.csv', text), 'roles.csv')).toEqual([
      '3: expected 2 columns but found 3',
    ]);
  });

  it('BR-2 rejects duplicate codes', () => {
    const chart = body('chart_of_accounts.csv', '1,A,asset,,true', '1,B,asset,,true');
    expect(messagesFor(withFile('chart_of_accounts.csv', chart), 'chart_of_accounts.csv')).toEqual([
      '3: duplicate code "1"',
    ]);
    const roles = body('roles.csv', 'boss,Boss', 'boss,Again');
    expect(messagesFor(withFile('roles.csv', roles), 'roles.csv')).toEqual([
      '3: duplicate code "boss"',
    ]);
  });

  it('BR-2 rejects unknown parent codes', () => {
    const cost = body('cost_codes.csv', '100,Materials,999,material');
    expect(messagesFor(withFile('cost_codes.csv', cost), 'cost_codes.csv')).toEqual([
      '2: parent_code "999" is not defined',
    ]);
  });

  it('BR-2 rejects cycles in hierarchies', () => {
    const cost = body(
      'cost_codes.csv',
      '1,Self,1,material',
      '2,Two,3,material',
      '3,Three,2,material',
      '4,Child,2,material',
    );
    expect(messagesFor(withFile('cost_codes.csv', cost), 'cost_codes.csv')).toEqual([
      '2: code "1" is its own ancestor (cycle)',
      '3: code "2" is its own ancestor (cycle)',
      '4: code "3" is its own ancestor (cycle)',
    ]);
  });

  it('BR-2 rejects unknown enum values', () => {
    const chart = body('chart_of_accounts.csv', '1,A,wealth,,yes');
    expect(messagesFor(withFile('chart_of_accounts.csv', chart), 'chart_of_accounts.csv')).toEqual([
      '2: type must be one of asset, liability, equity, income, expense',
      '2: active must be one of true, false',
    ]);
    const rules = body('tax_rules.csv', 'AUTH,works,North,5,2026-01-01,,');
    expect(messagesFor(withFile('tax_rules.csv', rules), 'tax_rules.csv')).toEqual([
      '2: applies_to must be one of goods, services',
    ]);
    const cost = body('cost_codes.csv', '100,A,,magic');
    expect(messagesFor(withFile('cost_codes.csv', cost), 'cost_codes.csv')[0]).toContain(
      'kind must be one of',
    );
    const policy = body('valuation_policy.csv', 'company,,lifo,2026-01-01');
    expect(messagesFor(withFile('valuation_policy.csv', policy), 'valuation_policy.csv')).toEqual([
      '2: method must be one of weighted_average, fifo',
    ]);
  });

  it('BR-2 rejects rates outside 0-100 and non-numbers', () => {
    const rules = body(
      'tax_rules.csv',
      'AUTH,goods,N,101,2026-01-01,,',
      'AUTH,goods,S,-1,2026-01-01,,',
      'AUTH,goods,E,abc,2026-01-01,,',
      'AUTH,goods,Z,0,2026-01-01,,',
      'AUTH,goods,H,100,2026-01-01,,',
    );
    expect(messagesFor(withFile('tax_rules.csv', rules), 'tax_rules.csv')).toEqual([
      '2: rate_percent must be between 0 and 100',
      '3: rate_percent must be between 0 and 100',
      '4: rate_percent must be a number',
    ]);
  });

  it('BR-2 rejects effective_to before effective_from and bad dates', () => {
    const rules = body(
      'withholding_rules.csv',
      'we_withhold,vendor,goods,1,bill,2026-06-01,2026-05-31',
      'we_withhold,vendor,services,1,bill,2026-02-30,',
      'we_withhold,vendor,labour,1,bill,2026-01-01,tomorrow',
      'we_withhold,vendor,rent,1,bill,2026-13-01,',
    );
    expect(messagesFor(withFile('withholding_rules.csv', rules), 'withholding_rules.csv')).toEqual([
      '3: effective_from must be a date in yyyy-mm-dd form',
      '4: effective_to must be a date in yyyy-mm-dd form',
      '5: effective_from must be a date in yyyy-mm-dd form',
      '2: effective_to is before effective_from',
    ]);
  });

  it('BR-2 rejects overlapping effective ranges for the same authority and rule', () => {
    const rules = body(
      'tax_rules.csv',
      'AUTH,services,North,5,2026-01-01,2026-12-31,',
      'AUTH,services,North,6,2026-12-31,,',
      'AUTH,services,South,6,2026-12-31,,',
      'AUTH,services,North,7,2025-01-01,,',
    );
    expect(messagesFor(withFile('tax_rules.csv', rules), 'tax_rules.csv')).toEqual([
      '2: effective range overlaps row 5 for AUTH/services/North',
      '3: effective range overlaps row 2 for AUTH/services/North',
    ]);
  });

  it('rejects a tax rule for an unknown authority', () => {
    const rules = body('tax_rules.csv', 'NOPE,goods,N,5,2026-01-01,,');
    expect(messagesFor(withFile('tax_rules.csv', rules), 'tax_rules.csv')).toEqual([
      '2: authority "NOPE" is not defined',
    ]);
  });

  it('BR-2 rejects negative amounts and non-numbers', () => {
    const rules = body('approval_rules.csv', 'doc,-1,5,boss', 'doc,0,x,boss');
    expect(messagesFor(withFile('approval_rules.csv', rules), 'approval_rules.csv')).toEqual([
      '2: min_amount must not be negative',
      '3: max_amount must be a number',
    ]);
  });

  it('BR-2 rejects min_amount greater than max_amount', () => {
    const rules = body('approval_rules.csv', 'doc,0,10,boss', 'doc,10,10,boss', 'doc,20,15,boss');
    expect(messagesFor(withFile('approval_rules.csv', rules), 'approval_rules.csv')).toEqual([
      '4: min_amount is greater than max_amount',
    ]);
    const overlap = body('approval_rules.csv', 'doc,0,10,boss', 'doc,5,,boss');
    expect(messagesFor(withFile('approval_rules.csv', overlap), 'approval_rules.csv')).toEqual([
      '3: doc band overlaps the band before it',
    ]);
    const open = body('approval_rules.csv', 'doc,0,,boss', 'doc,50,,boss');
    expect(messagesFor(withFile('approval_rules.csv', open), 'approval_rules.csv')).toEqual([
      '3: doc band overlaps the open-ended band at row 2',
    ]);
    const start = body('approval_rules.csv', 'doc,5,,boss');
    expect(messagesFor(withFile('approval_rules.csv', start), 'approval_rules.csv')).toEqual([
      '2: doc band leaves a gap: expected min_amount 0',
    ]);
  });

  it('rejects approval steps naming an unknown role, ignoring empty steps', () => {
    const rules = body('approval_rules.csv', 'doc,0,,boss|ghost', 'other,0,,boss|');
    expect(messagesFor(withFile('approval_rules.csv', rules), 'approval_rules.csv')).toEqual([
      '2: steps role "ghost" is not defined in roles.csv',
    ]);
  });

  it('rejects role permissions for an unknown role or a repeated pair', () => {
    const perms = body('role_permissions.csv', 'ghost,a.b.c', 'clerk,a.b.c', 'clerk,a.b.c');
    expect(messagesFor(withFile('role_permissions.csv', perms), 'role_permissions.csv')).toEqual([
      '4: duplicate role_code + permission_code "clerk|a.b.c"',
      '2: role_code "ghost" is not defined',
    ]);
  });

  it('BR-4 requires exactly one company row on the first date', () => {
    const none = body('valuation_policy.csv', 'category,CAT,fifo,2026-01-01');
    expect(messagesFor(withFile('valuation_policy.csv', none), 'valuation_policy.csv')).toEqual([
      '0: exactly one company row must start on the first date 2026-01-01, found 0',
    ]);
    const two = body(
      'valuation_policy.csv',
      'company,,fifo,2026-01-01',
      'company,,weighted_average,2026-01-01',
    );
    expect(messagesFor(withFile('valuation_policy.csv', two), 'valuation_policy.csv')).toEqual([
      '3: duplicate scope + category_code + effective_from "company||2026-01-01"',
      '0: exactly one company row must start on the first date 2026-01-01, found 2',
    ]);
  });

  it('BR-4 ties category_code to scope', () => {
    const policy = body(
      'valuation_policy.csv',
      'company,CAT,fifo,2026-01-01',
      'category,,fifo,2026-01-01',
    );
    expect(messagesFor(withFile('valuation_policy.csv', policy), 'valuation_policy.csv')).toEqual([
      '2: category_code must be blank for company scope',
      '3: category_code is required for category scope',
    ]);
  });

  it('rejects bad numbering series values and duplicates', () => {
    const series = body(
      'number_series.csv',
      'a,AA,0,true,true,1',
      'a,AA,4,maybe,true,0',
      'c,CC,x,true,true,1',
    );
    expect(messagesFor(withFile('number_series.csv', series), 'number_series.csv')).toEqual([
      '2: padding must be a whole number of 1 or more',
      '3: reset_yearly must be one of true, false',
      '3: start_value must be a whole number of 1 or more',
      '4: padding must be a whole number of 1 or more',
      '3: duplicate code "a"',
      '3: duplicate prefix "AA"',
    ]);
  });

  it('rejects duplicate rounding contexts and bad decimals', () => {
    const rounding = body('rounding.csv', 'line,half_up,2', 'line,half_up,-1', ',,0');
    expect(messagesFor(withFile('rounding.csv', rounding), 'rounding.csv')).toEqual([
      '3: decimals must be a whole number of 0 or more',
      '4: context is required',
      '4: mode is required',
      '3: duplicate context "line"',
    ]);
  });
});

describe('helpers', () => {
  it('reads an absent column as blank', () => {
    expect(get({ a: 'x' }, 'a')).toBe('x');
    expect(get({ a: 'x' }, 'b')).toBe('');
  });

  it('isoDate accepts real dates only', () => {
    expect(isoDate('2026-02-28')).toBe(true);
    expect(isoDate('2026-02-30')).toBe(false);
    expect(isoDate('2026-2-3')).toBe(false);
    expect(isoDate('2026-13-01')).toBe(false);
  });

  it('checkBands reports a message naming the file', () => {
    const issues = checkBands('f.csv', [{ row: 2, group: 'g', min: '5', max: '' }]);
    expect(issues).toEqual([
      { file: 'f.csv', row: 2, message: 'g band leaves a gap: expected min_amount 0' },
    ]);
  });
});

const adr = (status: string, by = '', date = ''): string =>
  `# ADR-001 Title\n\n- Status: ${status}\n- Decided by: ${by}\n- Date: ${date}\n`;

describe('validateAdr', () => {
  it('passes a pending ADR without approver or date', () => {
    expect(validateAdr('ADR-001.md', adr('pending'))).toEqual([]);
  });

  it('T-3 fails an accepted ADR without approver or date', () => {
    expect(validateAdr('ADR-001.md', adr('accepted'))).toEqual([
      {
        file: 'ADR-001.md',
        row: 4,
        message: 'an accepted ADR needs "Decided by" naming the accountant and/or the owner',
      },
      { file: 'ADR-001.md', row: 5, message: 'an accepted ADR needs "Date" in yyyy-mm-dd form' },
    ]);
  });

  it('passes an accepted ADR with approvers and a date', () => {
    expect(validateAdr('a.md', adr('accepted', 'owner, Accountant', '2026-10-27'))).toEqual([]);
    expect(validateAdr('a.md', adr('accepted', 'owner and accountant', '2026-10-27'))).toEqual([]);
  });

  it('rejects an approver who is neither accountant nor owner', () => {
    expect(validateAdr('a.md', adr('accepted', 'the agent', '2026-10-27'))).toHaveLength(1);
  });

  it('rejects an invalid date', () => {
    expect(validateAdr('a.md', adr('accepted', 'owner', '27/10/2026'))).toHaveLength(1);
  });

  it('points at the status line when the other lines are absent', () => {
    expect(validateAdr('a.md', 'Status: accepted\n')).toEqual([
      {
        file: 'a.md',
        row: 1,
        message: 'an accepted ADR needs "Decided by" naming the accountant and/or the owner',
      },
      { file: 'a.md', row: 1, message: 'an accepted ADR needs "Date" in yyyy-mm-dd form' },
    ]);
  });

  it('rejects a missing or unknown status', () => {
    expect(validateAdr('a.md', '# no status\n')).toEqual([
      { file: 'a.md', row: 0, message: 'Status must be "pending" or "accepted"' },
    ]);
    expect(validateAdr('a.md', '# x\n- Status: draft\n')[0]?.row).toBe(2);
  });
});

describe('validateAdrs', () => {
  it('requires all eight records', () => {
    const files = Object.fromEntries(adrIds.map((id) => [`${id}-x.md`, adr('pending')]));
    expect(validateAdrs(files)).toEqual([]);
    delete files['ADR-008-x.md'];
    expect(validateAdrs(files)).toEqual([
      { file: 'ADR-008', row: 0, message: 'decision record is missing' },
    ]);
  });

  it('reports problems with the file name', () => {
    const files = Object.fromEntries(adrIds.map((id) => [`${id}-x.md`, adr('accepted')]));
    expect(validateAdrs(files)[0]?.file).toBe('ADR-001-x.md');
  });
});
