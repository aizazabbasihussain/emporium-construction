const { buildRules } = require('./tools/depcruise-rules.cjs');

module.exports = {
  forbidden: buildRules(),
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    exclude: { path: '(^|/)(dist|coverage)/' },
  },
};
