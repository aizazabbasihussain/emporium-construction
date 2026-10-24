# 04. Autonomous Run

How the build runs unattended: one fresh agent session per spec, pull requests merged automatically when CI is green. This extends `01-agent-workflow.md`; where they differ, this file wins for runs started by `tools/agent/loop.mjs`.

## Start the loop (human)

```
node tools/agent/loop.mjs                 # runs until nothing can start
node tools/agent/loop.mjs --dry-run       # shows the next spec only
node tools/agent/loop.mjs --max-specs 3   # at most three specs
```

Stop it by creating an empty file `.agent-stop` in the repo root. Session logs go to `.agent-logs/` (git-ignored).

The loop picks the spec (`node specs/tools/next-spec.mjs`), starts `claude -p` with the prompt "read specs/04-autonomous-run.md and build spec <ID>", waits for it to finish, checks that the spec is `done` on `main`, and starts the next session. It stops on the first spec that does not end `done`.

## Session rules (agent)

You are one session building exactly one spec. Your context starts empty; everything you need is in the repository.

1. **Orient.** `git checkout main && git pull --ff-only`. Read `00-constitution.md`, `01-agent-workflow.md`, the spec named in your prompt, and the Boundary and Interfaces sections of its dependencies. Check that the tree is clean.
2. **Inputs.** Apply `01-agent-workflow.md` section 2. If a required input is `open` with default allowed `no`, stop, change nothing, and say which input is missing.
3. **Build and verify** exactly as `01-agent-workflow.md` sections 3 and 4. Branch `spec/<ID>-<slug>`. Commits follow Conventional Commits and end with the Co-Authored-By line from your session instructions. Never skip hooks.
4. **Finish in the same PR.** Set the spec `status: done` and run `pnpm spec:status` so `STATUS.md` matches. (Auto-merge makes the separate "in-review" step and the follow-up status PR unnecessary.) Run `pnpm verify` again; it must pass.
5. **Open the PR** with the template in `01-agent-workflow.md` section 5:
   `node tools/agent/pr.mjs open <branch> "<ID>: <title>" <body-file>` (prints the PR number). Put the body file inside the repo, then delete it. End the body with the attribution line from your session instructions.
6. **Merge when green.** `node tools/agent/pr.mjs merge <number> --own-spec specs/phase-N/<spec file>`. Run it with the Bash tool's `run_in_background` (a foreground call is killed after 10 minutes) and act on its exit when you are notified; never start it twice for the same PR. The command waits for CI, merges only if every check passes, and refuses (exit 4) if the PR changes protected files. It exits non-zero on failed CI (5) or timeout (6).
   - CI failed: read the failure, fix it on the same branch, push, and run the merge command again. Maximum three fix rounds, then stop and report.
   - Refused (exit 4): do not work around it. Leave the PR open and report.
7. **Close out.** After a merge: `git checkout main && git pull --ff-only`, delete the local branch, and confirm `specs/STATUS.md` shows the spec `done`. Then end the session with a short report: PR number, what was built, coverage, any default input used.

## What is never auto-merged

The merge command refuses a PR that touches any of: `specs/00-*` to `specs/04-*`, `specs/CHANGES.md`, `specs/tools/`, another spec's file, `.github/`, `.husky/`, `vitest.*`, `eslint.config.*`, `commitlint.config.*`, the dependency-cruiser rules, `tools/agent/`, `.gitignore`, `.env*`. Those are quality gates and the rules themselves; a human reviews them.

Also stop (do not merge) when the PR body's "Deviations and questions" section is not "none", when a spec is ambiguous, or when you would need to change a spec. Write the proposal in `CHANGES.md` on a separate branch, open its PR, and stop.

## Hard rules (unchanged)

No pushes to `main`. No lowering coverage thresholds, deleting tests or adding coverage ignores. No secrets in commits. No real client, worker or financial data. One spec per session and per PR.
