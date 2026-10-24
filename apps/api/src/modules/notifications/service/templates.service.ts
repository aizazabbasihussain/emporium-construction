import { ValidationError } from '@emporium/domain';
import { approvalNotificationTemplates } from '@emporium/shared';

export interface TemplateRegistry {
  /** Modules register their own templates at startup; the same code with the same key is a no-op. */
  register(code: string, i18nKey: string): void;
  /** BR-9: an unknown template fails fast instead of producing an unreadable notification. */
  require(code: string): string;
  list(): { code: string; i18nKey: string }[];
}

export function createTemplateRegistry(): TemplateRegistry {
  const templates = new Map<string, string>(Object.entries(approvalNotificationTemplates));
  return {
    register(code, i18nKey) {
      if (code === '' || i18nKey === '') {
        throw new ValidationError('template_invalid', 'A template needs a code and an i18n key');
      }
      const existing = templates.get(code);
      if (existing !== undefined && existing !== i18nKey) {
        throw new ValidationError(
          'template_conflict',
          `Template ${code} is already registered with another i18n key`,
        );
      }
      templates.set(code, i18nKey);
    },
    require(code) {
      const key = templates.get(code);
      if (key === undefined) {
        throw new ValidationError(
          'unknown_template',
          `Notification template ${code} is not registered`,
        );
      }
      return key;
    },
    list: () => [...templates].map(([code, i18nKey]) => ({ code, i18nKey })),
  };
}
