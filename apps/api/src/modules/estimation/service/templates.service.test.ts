import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { line, seedMasters, tx, wallTemplate, type Fixture } from '../fixtures.js';
import {
  auditCount,
  createEstimationKit,
  eventCount,
  type EstimationKit,
} from '../test-support.js';
import type { TemplateInput } from './templates.service.js';

let kit: EstimationKit;
let fixture: Fixture;
const templates = () => kit.estimation.templates;
const create = (input: TemplateInput) => tx(kit, (t) => templates().create(input, kit.actor, t));

beforeAll(async () => {
  kit = await createEstimationKit();
  fixture = await seedMasters(kit);
}, 60_000);
afterAll(() => kit.close());

describe('templates (BR-2, BR-10)', () => {
  it('creates a template with parameters and formula lines, audit and event', async () => {
    const template = await create(wallTemplate(kit, fixture, 'WALL-A'));
    expect(template).toMatchObject({ code: 'WALL-A', workType: 'boundary_wall', active: true });
    expect(template.parameters.map((p) => p.key)).toEqual(['length', 'height']);
    expect(template.lines.map((l) => [l.lineNo, l.qtyFormula, l.defaultRate])).toEqual([
      [1, 'ceil(length * height * 13.5)', '20.0000'],
      [2, 'ceil(length * height * 0.2)', '1000.0000'],
      [3, 'ceil(length * height / 50)', null],
    ]);
    expect(await auditCount(kit.db, 'estimation.template.create')).toBeGreaterThanOrEqual(1);
    expect(await eventCount(kit.db, 'estimation.template.changed')).toBeGreaterThanOrEqual(1);
    expect(await templates().get(kit.db, template.id)).toEqual(template);
  });

  it('rejects a code that is already used, in any letter case', async () => {
    await create(wallTemplate(kit, fixture, 'DUP'));
    await expect(create(wallTemplate(kit, fixture, 'dup'))).rejects.toMatchObject({
      code: 'code_taken',
    });
  });

  it('validates the template as a whole', async () => {
    const base = wallTemplate(kit, fixture, 'BAD');
    const bad = (over: Partial<TemplateInput>) => create({ ...base, ...over });
    const badLine = (over: Record<string, unknown>) =>
      bad({
        lines: [
          { ...(base.lines[0] as object), ...over } as unknown as TemplateInput['lines'][number],
        ],
      });

    await expect(bad({ code: ' ' })).rejects.toMatchObject({ code: 'code_required' });
    await expect(bad({ name: ' ' })).rejects.toMatchObject({ code: 'name_required' });
    await expect(bad({ workType: 'castle' })).rejects.toMatchObject({ code: 'invalid_work_type' });
    await expect(
      bad({ parameters: [{ key: 'Length', label: 'L', unit: 'ft' }] }),
    ).rejects.toMatchObject({ code: 'invalid_parameter_key' });
    await expect(
      bad({ parameters: [{ key: 'length', label: ' ', unit: 'ft' }] }),
    ).rejects.toMatchObject({ code: 'label_required' });
    await expect(badLine({ qtyFormula: 'length * width' })).rejects.toMatchObject({
      code: 'formula_unknown_identifier',
    });
    await expect(badLine({ qtyFormula: 'length *' })).rejects.toMatchObject({
      code: 'formula_syntax',
    });
    await expect(badLine({ qtyFormula: ' ' })).rejects.toMatchObject({ code: 'formula_required' });
    await expect(badLine({ description: ' ' })).rejects.toMatchObject({
      code: 'description_required',
    });
    await expect(badLine({ lineKind: 'gold' })).rejects.toMatchObject({
      code: 'invalid_line_kind',
    });
    await expect(badLine({ suppliedBy: 'nobody' })).rejects.toMatchObject({
      code: 'invalid_supplied_by',
    });
    await expect(badLine({ defaultRate: '-3' })).rejects.toMatchObject({ code: 'invalid_rate' });
    await expect(badLine({ unitCode: 'parsec' })).rejects.toMatchObject({ code: 'unknown_unit' });
    await expect(badLine({ itemId: '018f0000-0000-7000-8000-000000000999' })).rejects.toMatchObject(
      { code: 'unknown_item' },
    );
    await expect(
      badLine({ costCodeId: '018f0000-0000-7000-8000-000000000999' }),
    ).rejects.toMatchObject({ code: 'unknown_cost_code' });
  });

  it('applies the salvage rule and the cost code kind rule (BR-9, BR-11)', async () => {
    const base = wallTemplate(kit, fixture, 'RULES');
    const salvage = {
      ...line(kit),
      lineKind: 'salvage_credit',
      costCodeId: kit.costCodes.overhead,
      qtyFormula: '1',
    };
    await expect(create({ ...base, lines: [salvage] })).rejects.toMatchObject({
      code: 'salvage_not_allowed',
    });
    const demolition = await create({
      ...base,
      code: 'DEMO',
      workType: 'demolition',
      lines: [salvage],
    });
    expect(demolition.lines[0]?.lineKind).toBe('salvage_credit');
    await expect(
      create({
        ...base,
        code: 'MISMATCH',
        lines: [{ ...salvage, lineKind: 'labour', costCodeId: kit.costCodes.material }],
      }),
    ).rejects.toMatchObject({ code: 'cost_code_kind_mismatch' });
  });

  it('updates the template and replaces its lines, with a version check', async () => {
    const template = await create(wallTemplate(kit, fixture, 'UPD'));
    const changed = await tx(kit, (t) =>
      templates().update(
        template.id,
        {
          ...wallTemplate(kit, fixture, 'UPD'),
          name: 'Renamed',
          active: false,
          lines: [wallTemplate(kit, fixture).lines[0] as TemplateInput['lines'][number]],
        },
        template.version,
        kit.actor,
        t,
      ),
    );
    expect(changed).toMatchObject({
      name: 'Renamed',
      active: false,
      version: template.version + 1,
    });
    expect(changed.lines).toHaveLength(1);
    await expect(
      tx(kit, (t) =>
        templates().update(
          template.id,
          wallTemplate(kit, fixture, 'UPD'),
          template.version,
          kit.actor,
          t,
        ),
      ),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(
      tx(kit, (t) =>
        templates().update(
          '018f0000-0000-7000-8000-000000000999',
          wallTemplate(kit, fixture, 'GONE'),
          1,
          kit.actor,
          t,
        ),
      ),
    ).rejects.toMatchObject({ code: 'template_not_found' });
  });

  it('removes a template softly, with a version check', async () => {
    const template = await create(wallTemplate(kit, fixture, 'DEL'));
    await expect(
      tx(kit, (t) => templates().remove(template.id, template.version + 5, kit.actor, t)),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await tx(kit, (t) => templates().remove(template.id, template.version, kit.actor, t));
    await expect(templates().get(kit.db, template.id)).rejects.toMatchObject({
      code: 'template_not_found',
    });
    await expect(
      tx(kit, (t) => templates().remove(template.id, template.version, kit.actor, t)),
    ).rejects.toMatchObject({ code: 'template_not_found' });
    // The code can be used again once the template is deleted.
    await create(wallTemplate(kit, fixture, 'DEL'));
  });

  it('copies a template under a new code (BR-10)', async () => {
    const template = await create(wallTemplate(kit, fixture, 'SRC'));
    const copy = await tx(kit, (t) =>
      templates().copy(template.id, { code: 'SRC-V2', name: 'Boundary wall v2' }, kit.actor, t),
    );
    expect(copy.id).not.toBe(template.id);
    expect(copy).toMatchObject({
      code: 'SRC-V2',
      name: 'Boundary wall v2',
      workType: 'boundary_wall',
    });
    expect(copy.lines).toEqual(template.lines);
    await expect(
      tx(kit, (t) => templates().copy(template.id, { code: 'SRC', name: 'x' }, kit.actor, t)),
    ).rejects.toMatchObject({ code: 'code_taken' });
    await expect(
      tx(kit, (t) =>
        templates().copy(
          '018f0000-0000-7000-8000-000000000999',
          { code: 'Z', name: 'z' },
          kit.actor,
          t,
        ),
      ),
    ).rejects.toMatchObject({ code: 'template_not_found' });
  });

  it('lists with search, work type, active filter and paging', async () => {
    await create({ ...wallTemplate(kit, fixture, 'LIST-ROOM'), workType: 'room', active: false });
    const all = await templates().list(kit.db, { limit: 100, offset: 0 });
    expect(all.total).toBe(all.items.length);
    const rooms = await templates().list(kit.db, { workType: 'room', limit: 50, offset: 0 });
    expect(rooms.items.map((t) => t.code)).toContain('LIST-ROOM');
    const inactive = await templates().list(kit.db, { active: false, limit: 50, offset: 0 });
    expect(inactive.items.every((t) => !t.active)).toBe(true);
    const found = await templates().list(kit.db, { q: 'list-ro', limit: 50, offset: 0 });
    expect(found.items.map((t) => t.code)).toEqual(['LIST-ROOM']);
    const page = await templates().list(kit.db, { limit: 1, offset: 1 });
    expect(page).toMatchObject({ limit: 1, offset: 1 });
    expect(page.items).toHaveLength(1);
    const blank = await templates().list(kit.db, { q: '  ', limit: 5, offset: 0 });
    expect(blank.items.length).toBeGreaterThan(0);
  });
});

describe('formula preview (T-1, T-7)', () => {
  const parameters = [
    { key: 'length', label: 'Length', unit: 'ft' },
    { key: 'height', label: 'Height', unit: 'ft' },
  ];

  it('shows the quantity for sample values and the error code for a bad formula', () => {
    const results = templates().previewFormulas({
      parameters,
      values: { length: '100', height: '6' },
      formulas: [
        'ceil(length * height * 13.5)',
        'length / 0',
        'length * width',
        '(',
        'length - 1000',
        'constructor',
      ],
    });
    expect(results.map((r) => [r.ok, r.quantity, r.errorCode])).toEqual([
      [true, '8100.0000', null],
      [false, null, 'formula_division_by_zero'],
      [false, null, 'formula_unknown_identifier'],
      [false, null, 'formula_syntax'],
      [false, null, 'quantity_negative'],
      [false, null, 'formula_unknown_identifier'],
    ]);
  });

  it('treats a missing sample value as zero and rejects a bad one', () => {
    expect(
      templates().previewFormulas({
        parameters,
        values: { length: '3' },
        formulas: ['length + height'],
      })[0],
    ).toMatchObject({ ok: true, quantity: '3.0000' });
    expect(() =>
      templates().previewFormulas({ parameters, values: { length: 'x' }, formulas: ['1'] }),
    ).toThrow(expect.objectContaining({ code: 'invalid_length' }));
    expect(() =>
      templates().previewFormulas({
        parameters: [{ key: 'MAX', label: 'x', unit: '' }],
        values: {},
        formulas: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_parameter_key' }));
  });

  it('does not hide a failure that is not a validation error', () => {
    expect(() =>
      templates().previewFormulas({
        parameters,
        values: {},
        formulas: [null as unknown as string],
      }),
    ).toThrow(TypeError);
  });
});
