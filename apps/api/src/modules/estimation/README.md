# estimation

Job templates and internal estimation (spec P1-07). A template holds lines whose quantities are
formulas over named parameters; an estimate instantiates a template, prices the lines, and shows
company cost, overhead, contingency and expected margin before a quotation is made.

- Formulas run in a small parser and evaluator on Decimal (`packages/domain/src/estimation/formula.ts`); nothing is evaluated as code.
- A locked estimate is read-only. A revision is a new draft copy with the same number and a higher revision; it supersedes the old estimate when it locks.
- Other modules use `getEstimate`, `lockEstimate` and `getEstimateCostLines` from `index.ts`, and the event `estimate.locked`.
- Real templates and rates are data entered or imported by an admin (H-15). No rate is seeded.
