import { approvalNotificationTemplates, en } from '@emporium/shared';
import { describe, expect, it } from 'vitest';
import { createTemplateRegistry } from './templates.service.js';

/** Resolves a dotted i18n key against the English catalogue. */
const translate = (key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en);

describe('template registry (BR-9, T-7)', () => {
  it('starts with the approval templates', () => {
    const registry = createTemplateRegistry();
    expect(registry.list().map((t) => t.code)).toEqual(Object.keys(approvalNotificationTemplates));
  });

  it('maps every registered template to an existing English string', () => {
    const registry = createTemplateRegistry();
    registry.register('lead.assigned', 'notifications.templates.approvalRequested');
    for (const { code, i18nKey } of registry.list()) {
      expect(translate(i18nKey), `${code} -> ${i18nKey}`).toEqual(expect.any(String));
    }
  });

  it('fails fast on an unknown template', () => {
    expect(() => createTemplateRegistry().require('no.such.template')).toThrow(
      expect.objectContaining({ code: 'unknown_template' }),
    );
  });

  it('returns the i18n key of a known template', () => {
    expect(createTemplateRegistry().require('approval.approved')).toBe(
      'notifications.templates.approvalApproved',
    );
  });

  it('accepts a repeat registration of the same key and refuses a different one', () => {
    const registry = createTemplateRegistry();
    registry.register('x.created', 'notifications.templates.approvalApproved');
    registry.register('x.created', 'notifications.templates.approvalApproved');
    expect(() =>
      registry.register('x.created', 'notifications.templates.approvalRejected'),
    ).toThrow(expect.objectContaining({ code: 'template_conflict' }));
  });

  it('refuses an empty code or key', () => {
    const registry = createTemplateRegistry();
    expect(() => registry.register('', 'k')).toThrow(
      expect.objectContaining({ code: 'template_invalid' }),
    );
    expect(() => registry.register('c', '')).toThrow(
      expect.objectContaining({ code: 'template_invalid' }),
    );
  });
});
