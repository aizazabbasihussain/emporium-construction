import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'specs/**',
      'docs/**',
      'tools/.selftest-tmp/**',
      '**/playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.es2021 },
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'vitest.config.ts',
            'vitest.coverage.ts',
            'eslint.config.js',
            'commitlint.config.js',
            'tools/*.mjs',
            '.dependency-cruiser.cjs',
            'tools/depcruise-rules.cjs',
            'packages/db/vitest.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      // Async handlers without await are normal for Fastify routes and test doubles.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Domain code is pure and uses named exports only.
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-exports': [
        'error',
        {
          restrictDefaultExports: {
            direct: true,
            named: true,
            defaultFrom: true,
            namedFrom: true,
            namespaceFrom: true,
          },
        },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
