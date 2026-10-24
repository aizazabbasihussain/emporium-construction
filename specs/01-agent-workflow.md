# 01. Agent Workflow

How the coding agent works through the specs. Follow these steps for **each** spec, in order. Runs started by `tools/agent/loop.mjs` follow `04-autonomous-run.md` where it differs (auto-merge on green CI, one session per spec).

## 1. Pick the next spec

1. Run `pnpm spec:check`. Read `STATUS.md`.
2. Choose the lowest-numbered spec whose status is `not-started` and whose `depends_on` are all `done`.
3. If none qualifies, stop and report what blocks.

## 2. Read before writing

1. `00-constitution.md`, then the spec, then the specs it depends on (their Boundary and Interfaces sections only).
2. Check `requires_inputs` in the spec's frontmatter against `03-human-inputs.md`.
   - Input `answered`: use it.
   - Input `open` and `default allowed: yes`: use the default and record it in the PR.
   - Input `open` and `default allowed: no`: **stop and ask the human.** Do not guess.
3. Set the spec status to `in-progress` in its frontmatter.

## 3. Build (in this order)

1. Create branch `spec/<ID>-<slug>` from an up-to-date `main`.
2. Write the migration(s) and `module.json`.
3. Write domain logic in `packages/domain` with its unit tests **first** (test-first for money, stock, tax, wage, approval logic).
4. Write repository functions with integration tests.
5. Write services and policies with unit tests.
6. Write routes with contract tests, then UI with component tests, then the end-to-end tests the spec lists.
7. Seed permissions and i18n keys.

## 4. Verify the whole module

1. Run the module's tests, then the full `pnpm verify`. Coverage on business logic must be 100%.
2. Walk the spec's Acceptance criteria one by one and tick them with evidence (test names).
3. Walk the Definition of Done in the constitution.
4. If something fails, fix it; do not lower thresholds, delete tests, or add coverage ignores to pass.

## 5. Push and hand over

1. Update the spec frontmatter: `status: in-review`.
2. Commit, push the branch, open the pull request.
3. PR body must contain:

```
## Spec
[<ID>] <title>

## What was built
<5 lines max>

## Acceptance criteria
- [x] AC-1 ... (test: <file>::<test name>)

## Coverage (business logic)
| Package or module | Lines | Branches | Functions | Statements |

## Migrations
<list>

## Inputs used
<H-xx answered / default used>

## Deviations and questions
<none, or list; anything here needs human decision>

## Definition of Done
<checklist from constitution section 11, ticked>
```

4. Stop. Wait for review. After merge, set `status: done` and regenerate `STATUS.md`.

## 6. Rules

- Do not change specs, the constitution or this file. Propose changes in `CHANGES.md`.
- Do not touch another module's tables or internals. Use its `index.ts`.
- Do not add features outside the spec, even small ones. Put ideas in `BACKLOG.md`.
- Do not use real client, worker or financial data anywhere.
- Never commit secrets. Never push to `main`.
- If a test reveals an ambiguity in the spec, stop and ask; do not pick an interpretation silently.
- Keep PRs to one spec.
