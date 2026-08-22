---
name: github-ci-fixer
description: >
  Diagnoses and auto-fixes failing GitHub Actions PR checks — especially
  "CI / core (pull_request)" and "CI / web (pull_request)" — by reading
  workflow files, reproducing every failure locally, and iterating until
  all checks pass. Use this skill whenever the user says their PR checks
  are failing, CI is red, "CI / core" or "CI / web" won't pass, build /
  lint / typecheck / tests are broken in CI, or their PR won't merge.
  Trigger on phrases like "checks are failing", "CI is broken", "GitHub
  Actions red", "my PR is stuck", or "CI / core is failing".
  This skill owns the full loop: read → diagnose → fix → rerun → repeat.
---

# GitHub CI Fixer

Fix failing GitHub Actions PR checks end-to-end.
**Priority targets: `CI / core (pull_request)` and `CI / web (pull_request)`.**

Full loop: read workflows → reproduce locally → diagnose → fix → rerun → repeat until green.

---

## Phase 0 — State Your Plan First

Before running a single command, tell the user:

```
## Investigation Plan

### Target checks
- CI / core (pull_request)
- CI / web (pull_request)

### Steps
1. Read every file in .github/workflows/
2. Map which jobs correspond to "CI / core" and "CI / web"
3. Extract the exact commands each job runs
4. Reproduce every command locally in order
5. Diagnose every failure (do NOT stop at first error)
6. Explain each suspected root cause before fixing
7. Implement safe fixes and rerun
8. Continue until all commands exit 0
9. Produce a final report listing every change made
```

**Wait for explicit user confirmation before editing any file.**

---

## Phase 1 — Read All Workflow Files

```bash
find .github/workflows -type f | sort
```

Read every `.yml` / `.yaml` file in full. For each file extract:

| What to extract                       | Why                                         |
| ------------------------------------- | ------------------------------------------- |
| `name:` of the workflow               | Maps to the GitHub check name               |
| `on:` triggers                        | Confirms it runs on `pull_request`          |
| Every `jobs.<id>.name`                | The display name shown in GitHub checks     |
| Every `run:` step                     | Commands to reproduce locally               |
| Every `uses:` action                  | Identifies setup steps (node, python, etc.) |
| `env:` at workflow / job / step level | Environment variable requirements           |
| `working-directory:` overrides        | Critical for monorepos                      |
| `strategy.matrix` values              | Which variant to reproduce locally          |

**Specifically look for jobs whose `name:` matches (case-insensitive):**

- `core` → this is `CI / core`
- `web` → this is `CI / web`

If the names don't obviously match, look at what the workflow file is
called (e.g. `ci.yml`) and check for jobs triggered on `pull_request`.

**Watch for:**

- `node-version` / `python-version` — note if it differs from local
- Cache steps (`actions/cache`, `actions/setup-node` with `cache:`) — skip locally
- `if:` conditions on steps — some steps are conditional; check if they'd run on a PR
- `needs:` dependencies between jobs — run prerequisite jobs first

---

## Phase 2 — Map CI / core and CI / web

After reading the files, output a clear mapping:

```
## Workflow Map

### CI / core  →  file: .github/workflows/ci.yml  →  job: core
Steps (in order):
  1. npm ci
  2. npm run build
  3. npm run typecheck
  4. npm test

### CI / web  →  file: .github/workflows/ci.yml  →  job: web
Steps (in order):
  1. npm ci
  2. npm run lint
  3. npm run build:web
  4. npm run test:web
```

If you cannot find a clear mapping, say so and list all jobs so the user
can identify which is which.

---

## Phase 3 — Reproduce Failures Locally

Run **all commands** for both jobs. Do NOT stop at the first failure.
Capture full stdout + stderr for every command.

### Step 3a — Environment check

```bash
node --version
npm --version   # or: yarn --version / pnpm --version
git branch --show-current
```

Note any version mismatches vs the workflow's `node-version`.

### Step 3b — Install dependencies

```bash
npm ci          # if package-lock.json exists
# or: yarn install --frozen-lockfile
# or: pnpm install --frozen-lockfile
```

If this fails → see **Lockfile** in the edge cases section.

### Step 3c — Run CI / core commands

```bash
# Run exactly what the workflow runs, e.g.:
npm run build
npm run typecheck   # or: tsc --noEmit
npm test            # or: vitest run / jest --ci / cargo test
```

### Step 3d — Run CI / web commands

```bash
# Run exactly what the workflow runs, e.g.:
npm run lint        # or: eslint . / biome check / ruff check
npm run build:web   # or: next build / vite build
npm run test:web
```

**Monorepo note:** If the repo has `packages/` or `apps/` directories,
check `working-directory:` in the workflow and `cd` there before running.

---

## Phase 4 — Diagnose Every Failure

For **each** failing command produce this table (do not skip any):

| Field               | Value                                          |
| ------------------- | ---------------------------------------------- |
| **Check**           | `CI / core` or `CI / web`                      |
| **Workflow file**   | `.github/workflows/xxx.yml`                    |
| **Job**             | job id                                         |
| **Step**            | exact `run:` value                             |
| **Error output**    | the meaningful error lines (not the whole log) |
| **Root cause**      | why it's failing                               |
| **Files involved**  | specific files / paths                         |
| **Severity**        | `blocking` or `warning`                        |
| **Recommended fix** | what to change                                 |

### Root cause lookup table

| Symptom                                     | Likely cause                         | Fix                                 |
| ------------------------------------------- | ------------------------------------ | ----------------------------------- |
| `Cannot find module 'X'`                    | Missing dep or wrong import path     | `npm install X` or fix import       |
| `Module not found: X`                       | Bundler can't resolve path           | Fix alias / path in config          |
| `error TS2...`                              | TypeScript type error                | Fix types per message               |
| `error TS6...`                              | tsconfig problem                     | Fix tsconfig                        |
| `ESLint: ...`                               | Lint rule violation                  | Fix code or run `eslint --fix`      |
| `Parsing error:` (ESLint)                   | ESLint parser mismatch               | Check `parser` in eslint config     |
| `Expected ... but got ...` (Prettier/Biome) | Formatting                           | Run formatter with `--write`        |
| `ENOENT: no such file`                      | Missing generated/built file         | Run build step first                |
| `command not found: X`                      | Missing devDependency                | Add to `devDependencies`            |
| `SyntaxError`                               | Bad JS/TS syntax                     | Fix the file                        |
| `Cannot read properties of undefined`       | Runtime error in test                | Fix test or source                  |
| Lockfile out of sync                        | `package-lock.json` stale            | `npm install`, commit lockfile      |
| `secret not found` / `undefined` env var    | Missing env var                      | Note it for GitHub secrets          |
| `FAIL src/...test...`                       | Test failure                         | Fix failing test                    |
| `husky: command not found`                  | Husky not installed                  | `npm run prepare`                   |
| Peer dep conflict                           | Version mismatch                     | Align versions                      |
| Case mismatch `./Foo` vs `./foo`            | Linux is case-sensitive, macOS isn't | Fix import casing to match filename |
| `Cannot use import statement`               | CJS/ESM mismatch                     | Check `"type"` in package.json      |
| Wrong branch / outdated rebase              | Branch diverged from base            | `git rebase origin/main`            |
| Changes outside PR scope                    | Accidental edits                     | Revert unrelated changes            |

---

## Phase 5 — Explain Before Fixing

For each blocking issue, before touching a file say:

```
### Proposed fix: [short title]
- **Why this causes the CI failure:** ...
- **What I will change:** `path/to/file` — describe the change
- **Why this is safe:** ...
```

Then implement the fix.

**Safe to auto-fix (no confirmation needed):**

- Auto-fixable lint: `eslint --fix` / `biome check --write` / `ruff --fix`
- Auto-fixable formatting: `prettier --write`
- Wrong import paths (typos, wrong case, missing extension)
- Missing `"types"` in `tsconfig.json`
- Missing `moduleNameMapper` for path aliases in jest config
- `npm install <missing-package>` for obviously missing deps
- Regenerate lockfile: `npm install` then commit

**Ask user before changing:**

- `tsconfig.json` compiler options (e.g. disabling `strict`, `noImplicitAny`)
- `package.json` version bumps
- Logic in source files
- Deleting files
- Anything that changes runtime behavior

---

## Phase 6 — Rerun and Iterate

After each fix round, rerun the full suite for both jobs:

```bash
# CI / core commands
npm run build && npm run typecheck && npm test

# CI / web commands
npm run lint && npm run build:web && npm run test:web
```

(Use the exact commands from the workflow, not the above examples.)

If anything still fails → return to Phase 4 with the new errors.

**Exit condition:** Every command that runs in `CI / core` and `CI / web`
exits with code `0` locally.

---

## Phase 7 — Final Summary Report

```markdown
## CI Fix Summary

### Check Status

- ✅ CI / core — all steps passing
- ✅ CI / web — all steps passing

### Commands confirmed passing

- `npm run build` ✅
- `npm run typecheck` ✅
- `npm test` ✅
- `npm run lint` ✅
- `npm run build:web` ✅
- `npm run test:web` ✅

### Files Modified

1. `path/to/file.ts` — description of change
2. `package-lock.json` — regenerated after install

### Fixes Applied

#### Fix 1: [Title]

- **Check affected:** CI / core
- **Root cause:** ...
- **Change:** ...

#### Fix 2: [Title]

- **Check affected:** CI / web
- **Root cause:** ...
- **Change:** ...

### Remaining Notes

- ENV VARS required in GitHub Actions secrets: `FOO`, `BAR`
- Local Node version (v18) differs from CI (v20) — may cause issues
- Warning-level lint issues left unfixed (non-blocking)
```

---

## Edge Cases

### Monorepo

- Check `package.json` `"workspaces"` / `pnpm-workspace.yaml` / `turbo.json`
- Check `working-directory:` in workflow steps
- Run commands from the right package dir, not repo root
- Each package may have its own `tsconfig.json` and lint config

### Lockfile mismatch

```bash
rm package-lock.json
npm install          # regenerates lockfile
git add package-lock.json
```

### Environment variables

- If a step needs `NEXT_PUBLIC_*`, `VITE_*`, or a secret key: it will fail in CI if not set in repo secrets
- Create a `.env.test` with dummy values for local reproduction
- Note them clearly in the report — do NOT try to add real secrets to files

### Case-sensitive paths (Linux CI vs macOS local)

```bash
# Find mismatched imports:
grep -r "from './" src/ | grep -i "mycomponent"
# Then check actual filename casing:
ls src/components/
```

### Generated files

- If CI runs `npm run generate` or `npm run codegen` before build, run it locally too
- Check for `pre` scripts: `prebuild`, `pretest` in `package.json`

### Path aliases

TypeScript path aliases need to be configured in **three places**:

1. `tsconfig.json` → `paths`
2. Bundler config (vite/webpack) → `resolve.alias`
3. Jest config → `moduleNameMapper`
   Missing any one of these will break in exactly the tool that's missing it.

### Wrong base branch / diverged branch

```bash
git log --oneline origin/main..HEAD    # see what's different
git rebase origin/main                  # sync with base
```

### Changes outside PR scope

```bash
git diff origin/main --name-only       # all changed files
```

Review this list. If files are changed that shouldn't be, revert them:

```bash
git checkout origin/main -- path/to/file
```

### OS differences (macOS vs Ubuntu CI)

- `sed -i` requires `-i ''` on macOS; CI runs Ubuntu where it doesn't
- Use `perl -i -pe` or Python for portable in-place edits
