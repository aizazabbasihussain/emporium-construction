#!/usr/bin/env node
// Generates an API module scaffold and its domain folder (P0-01 BR-12).
// Usage: pnpm module:new <name> [--prefix=abc]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
const prefixArg = args.find((a) => a.startsWith('--prefix='))?.slice('--prefix='.length);

function fail(message) {
  console.error(`module:new: ${message}`);
  process.exit(1);
}

if (!name) fail('usage: pnpm module:new <name> [--prefix=abc]');
if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
  fail(`invalid module name "${name}" (lowercase letters, digits and single hyphens)`);
}

const prefix = prefixArg ?? name.replace(/[^a-z]/g, '').slice(0, 3);
if (!/^[a-z]{2,4}$/.test(prefix)) fail(`invalid table prefix "${prefix}" (2-4 lowercase letters)`);

const camel = name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const pascal = camel[0].toUpperCase() + camel.slice(1);

const moduleDir = path.join(repoRoot, 'apps/api/src/modules', name);
const domainDir = path.join(repoRoot, 'packages/domain/src', name);
if (fs.existsSync(moduleDir)) fail(`apps/api/src/modules/${name} already exists`);
if (fs.existsSync(domainDir)) fail(`packages/domain/src/${name} already exists`);

const files = {
  [path.join(moduleDir, 'module.json')]:
    JSON.stringify(
      {
        name,
        tablePrefix: `${prefix}_`,
        exports: [`${camel}Ping`],
        consumes: [],
        eventsIn: [],
        eventsOut: [],
      },
      null,
      2,
    ) + '\n',
  [path.join(moduleDir, 'index.ts')]: `// The only public entry point of the ${name} module.
export { register${pascal}Routes } from './routes/${name}.routes.js';
export { ${camel}Ping } from './service/${name}.service.js';
`,
  [path.join(moduleDir, 'routes', `${name}.routes.ts`)]:
    `import type { FastifyInstance } from 'fastify';
import { canRead${pascal} } from '../policy/${name}.policy.js';
import { ${camel}Ping } from '../service/${name}.service.js';

export function register${pascal}Routes(app: FastifyInstance): void {
  app.get('/${name}/ping', () => ({ message: ${camel}Ping(canRead${pascal}('office') ? 'office' : 'none') }));
}
`,
  [path.join(moduleDir, 'service', `${name}.service.ts`)]:
    `import { normalise${pascal}Label } from '@emporium/domain/${name}';

export function ${camel}Ping(role: string): string {
  return \`${name}: \${normalise${pascal}Label(role)}\`;
}
`,
  [path.join(moduleDir, 'service', `${name}.service.test.ts`)]:
    `import { describe, expect, it } from 'vitest';
import { ${camel}Ping } from './${name}.service.js';

describe('${name} service', () => {
  it('builds a ping message', () => {
    expect(${camel}Ping(' Office ')).toBe('${name}: office');
  });
});
`,
  [path.join(moduleDir, 'policy', `${name}.policy.ts`)]:
    `export function canRead${pascal}(role: string): boolean {
  return role === 'office' || role === 'owner';
}
`,
  [path.join(moduleDir, 'policy', `${name}.policy.test.ts`)]:
    `import { describe, expect, it } from 'vitest';
import { canRead${pascal} } from './${name}.policy.js';

describe('${name} policy', () => {
  it.each([
    ['office', true],
    ['owner', true],
    ['guest', false],
  ])('role %s -> %s', (role, allowed) => {
    expect(canRead${pascal}(role)).toBe(allowed);
  });
});
`,
  [path.join(moduleDir, 'repo', '.gitkeep')]: '',
  [path.join(domainDir, 'index.ts')]: `export * from './${name}.js';
`,
  [path.join(domainDir, `${name}.ts`)]:
    `export function normalise${pascal}Label(value: string): string {
  return value.trim().toLowerCase();
}
`,
  [path.join(domainDir, `${name}.test.ts`)]: `import { describe, expect, it } from 'vitest';
import { normalise${pascal}Label } from './${name}.js';

describe('${name} domain', () => {
  it('trims and lower-cases labels', () => {
    expect(normalise${pascal}Label('  Mixed Case ')).toBe('mixed case');
  });
});
`,
};

for (const [file, content] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

console.log(`Created module "${name}" (table prefix ${prefix}_):`);
console.log(`  apps/api/src/modules/${name}/`);
console.log(`  packages/domain/src/${name}/`);
console.log('Add the prefix to constitution section 3 via CHANGES.md before using it.');
