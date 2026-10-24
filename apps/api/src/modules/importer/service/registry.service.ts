import { NotFoundError, ValidationError } from '@emporium/domain';
import type { ImporterDefinition, ImporterSummary, RegisteredImporter } from '../types.js';

export interface ImporterRegistry {
  /** Modules register their importer at startup; a duplicate or malformed definition is rejected. */
  register<T>(definition: ImporterDefinition<T>): void;
  get(code: string): RegisteredImporter;
  list(): ImporterSummary[];
}

const CODE = /^[a-z][a-z0-9_]*$/;

export function createImporterRegistry(): ImporterRegistry {
  const importers = new Map<string, RegisteredImporter>();

  return {
    register(definition) {
      const invalid = (message: string) =>
        new ValidationError('invalid_importer', `Importer ${definition.code}: ${message}`);
      if (!CODE.test(definition.code))
        throw invalid('code must be lowercase letters, digits and _');
      if (importers.has(definition.code)) throw invalid('already registered');
      if (definition.label.trim() === '') throw invalid('label is required');
      if (definition.columns.length === 0) throw invalid('at least one column is required');
      const names = definition.columns.map((c) => c.name.trim().toLowerCase());
      if (names.some((name) => name === '') || new Set(names).size !== names.length) {
        throw invalid('column names must be non-empty and unique');
      }
      const dependsOn = definition.dependsOn ?? [];
      if (dependsOn.includes(definition.code)) throw invalid('cannot depend on itself');
      importers.set(definition.code, {
        code: definition.code,
        label: definition.label,
        schema: definition.schema,
        columns: definition.columns,
        dependsOn,
        // Rows were produced by `schema`, so they have the type the definition expects.
        apply: (rows, ctx, tx) => definition.apply(rows as never, ctx, tx),
      });
    },

    get(code) {
      const found = importers.get(code);
      if (!found) throw new NotFoundError('importer_not_found', 'No such importer');
      return found;
    },

    list() {
      return [...importers.values()]
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((i) => ({
          code: i.code,
          label: i.label,
          dependsOn: [...i.dependsOn],
          columns: [...i.columns],
        }));
    },
  };
}
