import { permissionBelongsTo } from '@emporium/domain/identity';
import { ValidationError } from '@emporium/domain';

export interface PermissionRegistry {
  /** Modules declare the permission codes they own at startup (spec P1-02 section 2). */
  register(module: string, codes: readonly string[]): void;
  has(code: string): boolean;
  list(): string[];
}

export function createPermissionRegistry(): PermissionRegistry {
  const known = new Set<string>();
  return {
    register(module, codes) {
      const invalid = codes.find((code) => !permissionBelongsTo(code, module));
      if (invalid !== undefined) {
        throw new ValidationError(
          'invalid_permission_code',
          `Permission ${invalid} is not of the form ${module}.<resource>.<action>`,
        );
      }
      for (const code of codes) known.add(code);
    },
    has: (code) => known.has(code),
    list: () => [...known].sort(),
  };
}
