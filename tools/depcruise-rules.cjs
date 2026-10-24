/**
 * Module boundary rules (P0-01 BR-4). `root` is the path prefix of the repository layout, so the
 * same rules can be applied to a fixture tree in the self-tests.
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRules(root = '') {
  const prefix = root === '' ? '' : `${root.replace(/\/$/, '')}/`;
  const base = escapeRegExp(prefix);
  return [
    {
      name: 'no-other-module-internals',
      comment: 'A module may import another module only through its index.ts.',
      severity: 'error',
      from: { path: `^${base}apps/api/src/modules/([^/]+)/` },
      to: {
        path: `^${base}apps/api/src/modules/([^/]+)/`,
        pathNot: [
          `^${base}apps/api/src/modules/$1/`,
          `^${base}apps/api/src/modules/[^/]+/index\\.ts$`,
        ],
      },
    },
    {
      name: 'domain-stays-pure',
      comment: 'packages/domain must not import I/O or framework packages.',
      severity: 'error',
      from: { path: `^${base}packages/domain/src` },
      to: {
        dependencyTypes: ['core', 'npm', 'npm-dev', 'npm-peer', 'npm-optional', 'npm-unknown'],
        pathNot: ['node_modules/decimal\\.js/'],
      },
    },
    {
      name: 'domain-no-app-or-db-code',
      severity: 'error',
      from: { path: `^${base}packages/domain/src` },
      to: { path: `^${base}(apps|packages/db)/` },
    },
    {
      name: 'web-never-imports-api',
      severity: 'error',
      from: { path: `^${base}apps/web` },
      to: { path: `^${base}apps/api` },
    },
  ];
}

module.exports = { buildRules };
