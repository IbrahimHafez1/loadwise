| `react-index-as-key` | low |
| `react-fetch-in-effect-no-abort` | low |
| `react-inline-object-in-jsx-prop` | low |
| `angular-default-change-detection` | low |
| `vue-v-for-missing-key` | low |
| `dom-listener-without-cleanup` | low |
| `dom-unthrottled-scroll-resize` | low |
| `frontend-barrel-heavy-import` | low |
| `sql-select-star-in-query` | low |
| `react-missing-cleanup` | medium |
| `angular-subscribe-without-cleanup` | medium |
| `vue-watch-missing-cleanup` | medium |
| `dom-layout-thrashing` | medium |
| `webhook-missing-idempotency-check` | medium |
| `sequential-http-in-loop` | high |
| `check-then-update-race` | high |
| `payment-missing-idempotency-key` | high |# Loadwise

Loadwise checks a backend project before it ships. One CLI runs three checkers:

- **Performance** (`loadwise perf`): repeated database work, ORM and query integrity, blocking calls, collection complexity, migration safety, schema-aware indexes, OpenTelemetry traces, executed query plans and an optional read-only database inspection.
- **Maintainability** (`loadwise maint`): deep nesting, branch complexity, duplicate implementations, dependency cycles and the folder, placement and data-access rules a team declares.
- **Security** (`loadwise sec`) checks request data reaching sensitive operations, authentication and cryptography, exposed credentials, Docker and Compose configuration, declared row scopes, and optionally dependency advisories.

Each finding has a stable `#id` for review. Where a checker can generate an edit, it shows the diff and any assumptions to verify. Supported source rules accept a `loadwise-reviewed` comment with a reason for intentional code.

## Install

Use Node.js 22 or later. For this private preview, use the npm archive provided by the package owner. If you have the checkout, run `npm pack /path/to/loadwise` from your application directory to create the archive there. Install the filename that npm prints. For version 0.4.1-preview.16, run:

```sh
npm install --save-dev ./loadwise-cli-0.4.1-preview.16.tgz
npx loadwise --version
```

**With an AI coding agent**, say **“Run Loadwise”** in your project chat. The agent can run the installed CLI directly. It should check the findings against the code, explain what it would fix or leave alone and why, and let you choose before making edits. [Active-agent workflow and optional MCP setup](#using-loadwise-with-an-active-coding-agent)

**Working manually**, run `npx loadwise check` to see recommendations or `npx loadwise fix --yes` to apply eligible fixes. In VS Code or Cursor, you can also review findings on hover and apply individual fixes inline with the editor extension. [Editor setup and shortcuts](#editor)

### Try a finding and a fix

From the directory where you installed Loadwise, copy the bundled example to a disposable file and scan it. The copy command refuses to overwrite an existing file.

```sh
node -e "require('node:fs').copyFileSync('node_modules/@loadwise/cli/examples/slow.ts', 'loadwise-demo.ts', require('node:fs').constants.COPYFILE_EXCL)"
npx loadwise perf loadwise-demo.ts
npx loadwise explain array-repeated-membership
```

The sample reports three findings and exits 1. The membership finding shows repeated array searches for allowed customer IDs. Read its diff and note, then replace `FINDING_ID` below with the ID printed after `#` on that finding.

```sh
npx loadwise perf loadwise-demo.ts --fix --only FINDING_ID
npx loadwise perf loadwise-demo.ts
```

The second scan should report two findings. Remove the disposable copy when finished. In your own application, install its dependencies and generate any ORM client it uses, then run `npx loadwise check` from its root. Check the coverage notes for skipped inputs. Start with `--min-impact high` to triage a large report, then run without that filter to review the rest.

## Commands

| Command                                                              | What it does                                                                                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `loadwise` or `loadwise check [directory]`                           | Runs every checker on the directory (default: the current folder) and prints Performance, Maintainability, then Security.           |
| `loadwise check --only perf,maint`                                   | Runs only the listed checkers: a comma-separated list of `perf`, `maint` and `sec`, in any order.                                   |
| `loadwise check --skip maint`                                        | Runs every checker except the listed ones. `--only` and `--skip` cannot be combined.                                                |
| `loadwise perf [args...]`                                            | The full performance checker; `loadwise perf --help` lists its commands and flags. See [Performance checker](#performance-checker). |
| `loadwise maint [args...]`                                           | The full maintainability checker; `loadwise maint --help` lists its flags. See [Maintainability checker](#maintainability-checker). |
| `loadwise sec [args...]`                                             | The full security checker; `loadwise sec --help` lists its flags. See [Security checker](#security-checker).                        |
| `loadwise explain <rule-id>`                                         | Shows the default impact, a description and an example change when available. Works offline.                                        |
| `loadwise fix --yes`                                                 | Scans the current project once and applies eligible edits across the configured checkers.                                           |
| `loadwise agent init [--mode ask\|auto] [--hook [block\|warn\|off]]` | Writes project instructions for coding agents. Use `--hook` to configure a pre-commit hook.                                         |

`loadwise check` reuses the previous result for an unchanged Git project from the `loadwise` folder of the OS cache directory. Any edit to a tracked or untracked (not ignored) file, a package install that rewrites `node_modules`, a different flag or a new Loadwise version runs a fresh scan; `LOADWISE_NO_CACHE=1` always scans afresh. Fixes, `--staged`, `--changed-since`, `--online` and `--write-baseline` runs are never cached.

Choose the checkers by name, separated by spaces. With no names, Loadwise uses the project's configured checkers.

```bash
npx loadwise fix --all                            # all generated edits, including review suggestions
npx loadwise fix --all performance                # performance only
npx loadwise fix --all performance security       # performance and security
npx loadwise fix --yes maintainability            # automatic maintainability edits only
```

Manual findings have no generated edit. With `--all`, inspect the resulting diff and run the project's tests, especially for schema changes and edits that alter application behavior.

Each applied fix in a JavaScript or TypeScript file gets a `// Loadwise <rule-id>: <why>` comment above the fixed statement, and the changed lines are formatted with the project's own Prettier, honouring its config and `.prettierignore`; the rest of the file stays byte-identical. Without Prettier in the project the edits are written as generated, with a note. `--no-comments` and `--no-format` turn these off; the per-checker `--fix` takes the same flags.

### Project-specific fixes

The default `fix --yes` can simplify nested conditions that choose the same status string. It preserves evaluation order and short-circuiting. Two other transformations need individual review: making a locally used constant private can affect consumers outside the scan, and sharing a private helper between sibling TypeScript modules changes the files included in the build. Inspect those diffs before applying them by finding ID.

The unused-module check considers literal Node commands in operator documentation and corroborated container entry points. Running a script establishes that the file is used; its unused exports can still be reported. The performance checker also recognizes supported Drizzle helpers that already receive a batch of keys.

For private TypeScript applications that control their consumers, Loadwise includes a compiler-backed recipe for unused type exports:

```bash
npx loadwise fix --all --recipe verified-private-types
```

This applies the usual generated fixes and also considers making locally used type declarations private. It checks the proposed type edits against the application with the bundled TypeScript compiler before offering them. The extra compilation takes time, and can verify only consumers included in the project. Omit this recipe when other repositories import your types.

If your project has a policy for a manual finding, you can encode it once in a local CommonJS recipe and share the file with your team. Run it alongside the built-in fixes for the selected checkers:

```bash
npx loadwise fix --all maintainability --recipe ./loadwise-fixes.cjs
```

For example, suppose a failed cache refresh in one maintenance script must fail the job. This recipe handles an empty catch at that specific site:

```js
module.exports = {
  'maint/swallowed-error'({ finding, source }) {
    if (finding.file !== 'scripts/refresh-cache.ts') return null;
    const before = source.split(/\r?\n/)[finding.line - 1];
    if (before?.trim() !== '} catch {}') return null;
    return [{
      line: finding.line,
      before,
      after: before.replace('catch {}', "catch (error) { throw new Error('Cache refresh failed', { cause: error }); }"),
    }];
  },
};
```

Keys use `perf`, `maint`, or `sec` followed by the rule ID from the report. A handler receives the finding and the source file text. Return exact, whole-line replacements in that file or return `null` to leave the site manual. Loadwise tries recipes only where it has no built-in fix. It validates the proposed edits together before writing. Recipe files execute as local JavaScript, so run only recipes you trust and keep handlers free of side effects.

To apply automatic fixes across your project, run `npx loadwise fix --yes` from its root. Performance and security share a type-check when both are selected. The command lists manual changes and findings that need individual review by location and ID. A fix that touches lines reserved for review also requires individual review. Loadwise checks the remaining edits together before writing and exits 2 if a selected checker fails or is skipped, source lines have changed, or automatic fixes conflict. A successful application exits 0 even when manual findings remain. Review the diff, run your tests, and use `npx loadwise check` to see what remains.

`check` accepts these flags and passes them to every selected checker:

- `--json` prints one object with a key per selected checker, `{ "performance": report, "maintainability": report, "security": report }`. A checker that was skipped or could not run has `null`.
- `--format text|json|sarif|github` picks the output; `--json` is `--format json`. `sarif` prints SARIF 2.1.0 with one run per checker for GitHub code scanning, and `github` prints `::warning`/`::error`/`::notice` workflow annotations. `loadwise perf`, `loadwise maint` and `loadwise sec` accept it too. Exit codes do not depend on the format.
- `--include-contextual` also shows lower-priority findings, each with its reason.
- `--staged` or `--changed-since <git-ref>` reports only findings on changed lines.
- `--fail-on contract|all` sets the exit threshold. By default, performance and security fail on displayed findings, and a full maintainability scan fails on contract violations. Changed-line maintainability scans fail on any displayed finding. Configured rule levels can change these defaults.
- `--write-baseline [file]` records the current findings and `--baseline [file]` reports only findings not recorded. The default file is `loadwise-baseline.json` in the checked directory, with one section per checker; `loadwise perf`, `loadwise maint` and `loadwise sec` take the same flags and read or write only their own section. Entries match on rule, file and flagged code (the finding id), never the line number, with a count per entry so N recorded copies allow N findings. Text output ends with `N baseline findings hidden.` and `--json` adds `baselineHidden`. A full comparison reports the number of unmatched entries in `baselineStale`. A partial comparison, such as a changed-line or single-file scan, reports `null` because unscanned findings may still exist. Refresh the baseline using its original scope and settings. Not combinable with `--fix`, and `--write-baseline` not with `--staged` or `--changed-since`. `loadwise perf migrations` keeps its own per-file baseline.

The performance and security checkers use the directory's `tsconfig.json` or `jsconfig.json`; without one, `check` looks for workspace packages (`package.json` `workspaces`, `pnpm-workspace.yaml` or `lerna.json`) and checks each one's config in one report, grouped per package; `--workspace <name|path>` (repeatable) limits every checker to some packages. For a standalone package with a `package.json` and JavaScript sources only, `check` and `fix` infer source files using the project inventory without writing a config. A mixed JavaScript/TypeScript project still needs a source config. For a JavaScript file without a project config, use `npx loadwise perf path/to/file.js` and `npx loadwise sec path/to/file.js`. For Python, Go, Java, C# or Rust performance checks, run `npx loadwise perf polyglot src` explicitly. The security checker can still scan Dockerfiles, Compose files and tracked environment files. When selected together, both checkers share a type-check unless a baseline is being written. Source scans are read-only. When fixes are available, text reports include a `Fix all:` command, such as `npx loadwise perf -p tsconfig.json --fix --only <ids>`, that applies its fixes.

Exit codes: **0** passed, **1** a checker met its exit threshold, **2** invalid input or configuration in any checker, or a scan that skipped a file (see below).

A scan skips a JavaScript or TypeScript file that does not parse, or whose analysis fails, and still reports the findings of every other file. Each skipped file is named in a note on stderr and in a `skippedFiles` array of `{ file, reason }` in `--json` output, and the run exits 2, also with `--fix` and `--write-baseline`. A file that exists but cannot be read (the schema snapshot, `package.json`, a review directive) prints a note on stderr; an absent file stays silent.

On large projects the checkers run with a larger Node memory limit, 60% of the machine's memory, at least 4096 MB and at most 16384 MB (never below Node's own default). A `--max-old-space-size` you set in `NODE_OPTIONS` is never overridden. Direct `loadwise perf`, `loadwise sec` and `loadwise maint` runs re-launch once to apply the limit. If a checker still runs out of memory, `check` prints one line naming it and the limit it had, tells you to raise it with `NODE_OPTIONS=--max-old-space-size=<megabytes>`, and exits 2. When a checker exits 2 because it skipped files, `check` keeps its findings and `skippedFiles` in `--json` output, marks its SARIF run as not successful and emits a GitHub warning for each skipped file. A checker that produced no result is named on stderr and `check` exits 2. The native engine (`--engine native`) uses much less memory on most projects; [PERFORMANCE.md](PERFORMANCE.md) has the measurements.

## Configuration

One optional file, `loadwise.config.json`, sets the defaults for every checker. `loadwise check` looks for it in the checked directory and `loadwise perf` or `loadwise maint` in the project folder; `--config <file>` on `check` (`--loadwise-config <file>` on `perf` and `maint`) names another one. Add `$schema` for editor completion and validation.

```json
{
  "$schema": "./node_modules/@loadwise/cli/schema/loadwise.config.schema.json",
  "checkers": ["perf", "maint"],
  "ignore": ["generated/**", "scripts/**"],
  "rules": {
    "duplicate-implementation": "warn",
    "array-repeated-find": "off",
    "pg-query-in-loop": { "level": "error" }
  },
  "overrides": [{ "files": ["src/legacy/**"], "rules": { "high-branch-complexity": "off" } }],
  "performance": {
    "parallelReads": [{ "from": "@app/reads", "exports": ["fetchUser", "fetchPosts"] }]
  },
  "maintainability": {
    "exclude": ["vendor"],
    "placement": [{ "suffix": ".controller.ts", "under": ["src/controllers"] }]
  }
}
```

- `checkers` is the default selection for `loadwise check`; `--only` and `--skip` override it.
- `ignore` lists globs, relative to the config file, that no checker scans or reports on; they leave the scan itself, so they cost no time and never count toward duplicates, cycles or architecture. `*` matches within a folder, `**` any depth, `?` one character and `{a,b}` alternatives; naming a folder covers everything below it.
- `rules` sets each rule to `"off"` (its findings are dropped), `"warn"` (reported, but never changes the exit code) or `"error"` (reported findings always count, even under `--fail-on contract`). A hidden contextual finding is not reported, so it never counts. The object form `{ "level": "warn" }` is accepted for future rule options; no rule has options yet.
- `overrides` apply `rules` to the files matching `files`; a later override wins over an earlier one and over `rules`.
- `performance` holds what `backend-perf.policy.json` holds, and `maintainability` what the `maintainability.config.json` policy holds. The old files keep working when the config lacks the section; when both exist the config wins and a note says so. `--policy` and `--config policy.json` still beat the config.
- `--ignore <rule-id>` (repeatable, on `check`, `perf` and `maint`) adds a rule to `"off"` for one run and beats the config.

An unknown key or rule id, a wrong level or a malformed section exits with code 2 and lists each problem. Rule ids come from the registered checkers, so a rule id that no checker has yet is rejected. The config applies to source checks and `perf polyglot`; `perf migrations`, `db`, `traces` and `plan` do not read it.

## GitHub Action

The repository root is a composite action that runs `loadwise check`, prints annotations on the pull request and uploads SARIF to code scanning.

```yaml
name: loadwise
on: pull_request
permissions:
  contents: read
  security-events: write
jobs:
  loadwise:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: IbrahimHafez1/loadwise@v0
        with:
          changed-only: true
          fail-on: contract
```

| Input          | Default         | Meaning                                                                                               |
| -------------- | --------------- | ----------------------------------------------------------------------------------------------------- |
| `checkers`     | all             | Passed to `--only`, for example `perf,maint`.                                                         |
| `path`         | `.`             | Directory to check.                                                                                   |
| `changed-only` | `false`         | `true` passes `--changed-since` with the pull request base commit.                                    |
| `fail-on`      | checker default | Passed to `--fail-on` (`contract` or `all`).                                                          |
| `upload-sarif` | `true`          | Uploads the SARIF report with `github/codeql-action/upload-sarif@v4`; needs `security-events: write`. |
| `annotations`  | `true`          | Prints findings as workflow annotations.                                                              |

The action installs its locked runtime dependencies in a runner temporary directory and runs the source at the selected action ref. SARIF and workflow annotations share one scan. The checker exit code is applied after the SARIF upload step.

## Use with AI coding agents

Ask your coding agent to run Loadwise. On its first check or fix, the CLI gives a recognized agent the review workflow on stderr. A check lets the agent inspect every scoped finding, earlier edit, caller and test. A fix request also lets it apply or adapt justified changes. The agent can read the full workflow with `loadwise agent instructions`. The first run works in a fresh checkout and leaves project instruction files and Git hooks alone.

Loadwise recognizes agent shell markers from Codex, Claude Code, Cursor, Gemini CLI and GitHub Copilot, as well as tools that identify themselves with `AI_AGENT`. An integration that supplies no marker can set `LOADWISE_AGENT=1` in its tool subprocess. Set `LOADWISE_AGENT=0` on a command to disable detection. Commands typed in plain Git Bash or an ordinary IDE terminal run normally. A shell opened inside an agent can inherit its markers.

Agent-run CLI fixes save their actual edited hunks locally from the first fix. For earlier fixes and saved review decisions, run `loadwise agent history` from the checked project, optionally with a checker name such as `maintainability`. History stays under the user's local state directory and can include excerpts of project source. For unrecorded edits, including edits made on another machine, use an earlier report or a known diff.

For persistent project instructions, or to have a future agent review fixes you run manually in a terminal, use the optional setup command. It updates the managed section of `AGENTS.md`, imports it from `CLAUDE.md` and enables history for manual CLI fixes too.

```sh
npx loadwise agent init
```

Agents use the original scan, the relevant history and the rescan to check that every finding has a disposition. The outcomes file is an object with an `outcomes` array. Each entry supplies `checker`, `id`, `status` and specific `evidence`. Supported statuses are `fixed`, `verified`, `intentional`, `false-positive` and `deferred`. For a narrower request, provide only the authorized findings in those reports. With a local Loadwise installation, the commands below run from the project root; put report files in a local scratch directory.

```sh
npx loadwise agent verify --outcomes outcomes.json before.json history.json after.json
npx loadwise agent verify --save --outcomes outcomes.json before.json history.json after.json
```

The first command checks coverage. The second also retains successful review decisions for the next session in a recognized agent session or an explicitly initialized checkout. A missing decision or skipped checker is reported as incomplete. A reasoned deferral counts as reviewed and stays visible as deferred. Code review and relevant tests establish whether a change works.

For a standalone JSON scan, pass its checker name, for example `npx loadwise agent verify --checker maint --outcomes outcomes.json maint-scan.json`. Use `perf` for performance, migrations and database reports, `maint` for maintainability, and `sec` for security. Use one checker per invocation for unlabelled standalone reports. Combined scans and history keep their original checker selection.

To read or save the same brief yourself, use the same checker names as the fix request:

```sh
npx loadwise fix --handoff maintainability > loadwise-manual.md
```

### Using Loadwise with an active coding agent

Ask the agent you are already working with to check the project with Loadwise. A shell-capable agent can run `npx loadwise check --json` and review the findings directly in the conversation. Ask it to verify findings against your code, suggest improvements, or implement the changes you choose. A check is read-only. A request to apply fixes can use `npx loadwise fix --yes --json` and review the actual edits and remaining findings in the same chat.

For an agent that uses Model Context Protocol (MCP), install Loadwise in the project, then run:

```bash
npx loadwise agent mcp --print-config
```

Register the printed command and arguments as a local stdio server named `loadwise` in the agent. The agent can call `loadwise_check` to run a fresh offline scan and review the findings during the current turn. It can read larger reports in pages with `loadwise_read_report`. Loadwise does not start a chat or send findings to another session.

If you ran a terminal command yourself and want to share it later, use `npx loadwise check --review` or `npx loadwise fix --yes --review`. Paste the printed handoff into the chat you choose, or attach the report. The optional `loadwise agent pending` command and MCP tool `loadwise_list_reports` list saved reports for that project.

### Using Loadwise without AI

Run `npx loadwise check` to see findings or `npx loadwise fix --yes` to scan and apply automatic fixes. With editor diagnostics enabled, hover over a finding to see its recommendation. The optional editor extension adds inline **Apply fix**, Quick Fix, and **Apply all fixes in this file**. Findings that require judgment remain available for manual review. [Editor setup](#editor)

### Claude Code plugin

`agent init` gives Claude Code instructions; the plugin makes the check automatic. Install it from inside Claude Code:

```
/plugin marketplace add IbrahimHafez1/loadwise
/plugin install loadwise@loadwise
```

After every `Edit`, `Write` or `MultiEdit` on a `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts` or `.cts` file, a hook runs the project's locally installed `@loadwise/cli` on that file (`perf` and `sec` on the file, `maint` on the uncommitted changes, keeping that file's findings) with a 20 second limit. Findings go back to Claude with their ids and `--fix --only <id>` commands for the corresponding checker; a clean file prints nothing. The hook never downloads anything: without a local install, outside a project, on other file types, on a timeout or on any error it exits silently. The plugin also adds a `/loadwise [args]` command for read-only checks and a `/loadwise fix [checker names]` workflow for agent-reviewed remediation.

To turn the hook off, run `/plugin disable loadwise` (or `/plugin uninstall loadwise`).

### Git pre-commit hook

```sh
npx loadwise agent init --hook block   # a commit with new findings fails
npx loadwise agent init --hook warn    # findings are printed, the commit goes through (also plain --hook)
npx loadwise agent init --hook off     # removes only this block
```

The hook runs `loadwise check --staged` from the project folder, so every tool that commits through git sees findings from the selected checkers on the staged lines. It writes a marked block into the hooks folder (honouring `core.hooksPath`) or into `.husky/pre-commit` when `.husky/` exists, appends to a hook you already have, and rerunning it replaces only its own block, including blocks written by earlier releases. With lefthook it edits nothing and prints the command to add. `git commit --no-verify` skips the hook.

## Editor

Set up the editor task once from the project root.

```sh
npx loadwise perf editor init
```

Commit the generated `.vscode/tasks.json`. Open the trusted folder in VS Code or Cursor and allow automatic tasks once; the watcher then starts on every folder open (reopen the folder if it was already open during setup). **Tasks: Manage Automatic Tasks** controls the workspace's choice. Findings from both checkers appear in **View > Problems**. This works across supported source languages, including mixed-language projects, and needs Node.js 22+ on PATH and this package under `node_modules`.

Saving a file or completing a source scan from the project terminal refreshes the running watcher. The editor uses its configured project and rules even when the terminal command uses different flags, and a running watcher picks up package reinstalls. The default scan uses a root `tsconfig.json` or `jsconfig.json`, or explicit JS/TS files discovered by the watcher; append `-p` and a relative path to the task's arguments (it runs `perf editor watch [-p tsconfig.json]`) to use another config.

Hover over an underline to read the finding. The first line shows a source-based rewrite, an illustrative example or a review action. The hover retains the original finding and, where applicable, the code comparison.

The optional [editor extension](editor/README.md) adds syntax-highlighted hover examples, related-location links and fix actions in VS Code or Cursor:

- Each fixable line shows **Apply fix** and **Dismiss** CodeLens buttons, the hover has the same two links, and the Quick Fix menu offers the same actions.
- The shortcuts are the same on every OS: **Ctrl+Alt+.** applies the fix on the cursor line, **Ctrl+Alt+Shift+.** applies all fixes in the file, and **Ctrl+Alt+,** dismisses the finding on the cursor line.
- **Loadwise: Apply all fixes in this file** (also on save as `source.fixAll.loadwise`) applies every fix in one undoable edit.
- A finding, or a rule in one file, can be dismissed and restored with **Show dismissed findings**. `loadwise.severity` shows all findings at one level.

# Performance checker

`loadwise perf` finds repeated backend work before deployment or in a recorded request. It checks source code, OpenTelemetry traces and executed database plans. Findings include a location or trace identifier, a rule ID, and a suggested change to evaluate.

## What you get

| Capability                | Command                                  | Needs a database |
| ------------------------- | ---------------------------------------- | ---------------- |
| Source and ORM checks     | `loadwise perf -p tsconfig.json`         | No               |
| Migration safety          | `loadwise perf migrations`               | No               |
| API contract safety       | `loadwise perf contracts`                | No               |
| Schema-aware index checks | `loadwise perf --schema snap.json`       | No (snapshot)    |
| Live database inspection  | `loadwise perf db`                       | Yes, read-only   |
| Traces and executed plans | `traces trace.json`, `plan explain.json` | No               |

Text findings carry a stable `#id`, a **Fix** diff where one applies and, for loops and repeated spans, an **Impact:** line. Impact always says which side is measured and which is estimated.

```text
examples/slow.ts:7:48 [array-repeated-find #9ab891a8b8f7] medium: Each item can rescan the lookup array with find(), so cost grows with items times rows. Build `const byKey = new Map()` once (first match wins) and call `byKey.get(key)`; keep the original key-equality semantics.
  Fix (examples/slow.ts:7):
    - const names = visible.map(order => customers.find(customer => customer.id === order.customerId)?.name ?? 'Unknown');
    + const customersById = new Map(customers.map((customer) => [customer.id, customer] as const).reverse());
    + const names = visible.map(order => customersById.get(order.customerId)?.name ?? 'Unknown');
```

```text
00000000000000000000000000000001 parent 0000000000000010 [repeated-db-span] 5 sibling database calls share one operation signature, one round trip each. Batch them into one statement such as WHERE id = ANY($1), or reuse a shared result, if behavior allows it.
  Impact: 40 ms measured -> ~8 ms estimated; method: OTLP start/end times; after assumes one batched operation costs as much as the slowest span.
```

The second sample is `examples/repeated-db.otlp.json` with span timings added. A `~` marks an estimate. Loop findings (`*-query-in-loop`) show a round-trip model, and a measured figure only when `--schema` supplies a snapshot with a measured round trip. An Impact line in milliseconds is never printed without a measurement behind it.

## Start here

Try the two included implementations of the same order lookup. The first reports three findings. The second preserves the result order, the first matching customer and the fallback for a missing customer.

```sh
npx loadwise perf node_modules/@loadwise/cli/examples/slow.ts
npx loadwise perf node_modules/@loadwise/cli/examples/indexed.ts
```

Use the same one-shot commands in CI. Exit **0** means no displayed finding met the fail threshold, **1** means at least one did and **2** means the check could not complete or skipped a file. Add `--json` for structured output.

Source checks summarize contextual findings separately. They include certain one-off blocking calls in CLI startup or unit tests and write advisories in test sources. Use `--include-contextual` to display every candidate and its reason. JSON includes `contextualFindingCount` when any remain after explicit rule exclusions. In the default view this count is additional to the displayed findings. In the expanded view these entries appear in `findings` with a `contextualReason`.

The default `--fail-on all` applies to the displayed findings. For a complete advisory report that only fails CI on a transaction-client or import contract violation, use `npx loadwise perf --include-contextual --fail-on contract`. The enforced contract rule is `pg-transaction-on-pool`.

| Input                                   | Command after `npx loadwise perf`                                  | Coverage                                                                            |
| --------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| JavaScript or TypeScript                | `-p tsconfig.json`, `--watch -p tsconfig.json` or `src/handler.ts` | Typed database calls, collection algorithms, connections and synchronous Node APIs. |
| Python, Go, Java, C#, Rust              | `polyglot src`                                                     | Five narrowly scoped source patterns powered by a Rust binary.                      |
| OTLP/JSON from any application language | `traces request.otlp.json --threshold 5`                           | Repeated SQL or NoSQL operations, duplicate lookups and Redis/Valkey commands.      |
| Executed PostgreSQL or MongoDB plan     | `plan explain.json`                                                | Inefficient scans, disk sorts and deep pagination at individual plan stages.        |

## Source checks

Run in the directory containing `tsconfig.json` or `jsconfig.json`, pass `-p path/to/config.json`, or give explicit JS/TS files. A project check scans the config's input files and follows project references. Declaration files supply types. A standalone file check uses ES2022 and NodeNext compiler defaults. Use a project config for aliases, custom libraries and JS projects with `allowJs`. When a config leaves JavaScript files in its folder out because `allowJs` is off, a note names them.

| JS/TS rule                                                                                                                                                                                                                                                                     | Trigger and review                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="pg-query-in-loop"></a><a id="prisma-query-in-loop"></a>`pg-query-in-loop`, `prisma-query-in-loop`                                                                                                                                                                       | Per-item queries. Consider a parameterized set query, relation load or bulk write if ordering and transaction behavior permit it. Prisma can already batch compatible `findUnique` calls.                                                                                                                                                                                                       |
| <a id="pg-count-materialization"></a><a id="prisma-count-materialization"></a>`pg-count-materialization`, `prisma-count-materialization`                                                                                                                                       | Counting an immediately loaded result. Use a database count with equivalent predicates and handle its return type.                                                                                                                                                                                                                                                                              |
| <a id="pg-first-materialization"></a><a id="prisma-first-materialization"></a>`pg-first-materialization`, `prisma-first-materialization`                                                                                                                                       | Reading only index zero from an unbounded result. Preserve ordering and empty-result behavior when limiting the query.                                                                                                                                                                                                                                                                          |
| <a id="pg-filter-materialization"></a><a id="prisma-filter-materialization"></a>`pg-filter-materialization`, `prisma-filter-materialization`                                                                                                                                   | Applying a literal equality filter in JS after loading an unbounded result. Check database collation and null semantics before moving the predicate.                                                                                                                                                                                                                                            |
| <a id="pg-top-k-materialization"></a><a id="prisma-top-k-materialization"></a>`pg-top-k-materialization`, `prisma-top-k-materialization`                                                                                                                                       | Sorting an unbounded result with a numeric comparator to keep the top rows. Use database ordering and a limit with a stable tie-breaker.                                                                                                                                                                                                                                                        |
| <a id="rebuild-lookup-in-loop"></a><a id="array-repeated-membership"></a><a id="array-repeated-find"></a>`array-repeated-membership`, `array-repeated-find`, `rebuild-lookup-in-loop`                                                                                          | Repeated linear lookups or rebuilt indexes. Reuse a Set or Map if inputs are stable and enough lookups justify construction. Preserve first-match semantics with duplicate keys.                                                                                                                                                                                                                |
| <a id="reduce-copy-accumulator"></a><a id="loop-copy-accumulator"></a><a id="filter-for-existence"></a>`reduce-copy-accumulator`, `loop-copy-accumulator`, `filter-for-existence`                                                                                              | Copying a growing result or allocating a filtered array for a boolean test. Consider a private accumulator or a short-circuiting predicate.                                                                                                                                                                                                                                                     |
| <a id="pg-unreleased-checkout"></a><a id="pool-created-per-request-or-item"></a>`pool-created-per-request-or-item`, `pg-unreleased-checkout`                                                                                                                                   | A recognized pg, Prisma, MongoDB or Redis client/pool is created on a repeated path, or a chained pg checkout loses the client reference. Scope reuse to the right credentials and release checked-out clients.                                                                                                                                                                                 |
| <a id="node-sync-crypto-in-async"></a><a id="node-sync-process-in-async"></a><a id="node-sync-fs-in-async"></a><a id="node-sync-compression-in-async"></a>`node-sync-fs-in-async`, `node-sync-compression-in-async`, `node-sync-crypto-in-async`, `node-sync-process-in-async` | A recognized synchronous API blocks an async function. Examples include `readFileSync`, `gzipSync`, `scryptSync` and `execFileSync`.                                                                                                                                                                                                                                                            |
| <a id="redis-command-in-loop"></a>`redis-command-in-loop`                                                                                                                                                                                                                      | A per-key Redis or Valkey command on a repeated path. Use a multi-key command or a bounded pipeline if cluster slots, ordering and error handling permit it. SCAN cursor loops are skipped.                                                                                                                                                                                                     |
| <a id="password-hash-sync-in-async"></a>`password-hash-sync-in-async`                                                                                                                                                                                                          | `hashSync`, `compareSync` or `genSaltSync` from bcrypt or bcryptjs in an async function blocks the event loop for the whole hash. Use the promise form.                                                                                                                                                                                                                                         |
| <a id="serial-awaits-in-literal"></a>`serial-awaits-in-literal`                                                                                                                                                                                                                | An array or object awaits multiple values in order. The `Promise.all` edit requires review for shared resources, concurrency limits and failure ordering.                                                                                                                                                                                                                                       |
| <a id="queue-add-in-loop"></a>`queue-add-in-loop`                                                                                                                                                                                                                              | `queue.add` on a recognized job queue runs once per item, one Redis round trip each. Collect the jobs and call `addBulk`, unless a later job needs the earlier job's result or id.                                                                                                                                                                                                              |
| <a id="redis-keys-command"></a>`redis-keys-command`                                                                                                                                                                                                                            | `keys()` on a recognized ioredis or node-redis client blocks Redis while it scans the keyspace. Iterate with `SCAN` (`scanStream` or `scanIterator`) after reviewing duplicate keys, iteration order and concurrent writes.                                                                                                                                                                     |
| <a id="service-query-in-loop"></a>`service-query-in-loop`                                                                                                                                                                                                                      | A call in a loop reaches several database operations through a project function, so the loop pays round trips for every item. Add a batch variant. Test, seed, benchmark and script sources get a softer note.                                                                                                                                                                                  |
| <a id="http-call-without-timeout"></a>`http-call-without-timeout`                                                                                                                                                                                                              | A `fetch` or axios call has no `signal` or `timeout`, so a hung upstream holds the request. Set a timeout or an abort signal.                                                                                                                                                                                                                                                                   |
| <a id="upload-without-size-limit"></a>`upload-without-size-limit`                                                                                                                                                                                                              | A multer or Nest upload interceptor has no `limits.fileSize`, so one large upload can exhaust memory. A global `MulterModule.register({ limits })` set elsewhere is not visible to the check.                                                                                                                                                                                                   |
| <a id="password-hash-pure-js"></a>`password-hash-pure-js`                                                                                                                                                                                                                      | `bcryptjs` hashes in pure JavaScript and costs tens to hundreds of milliseconds of main-thread CPU per call. Use native `bcrypt`, `@node-rs/bcrypt` or `argon2`. Reported once per file; test files are skipped.                                                                                                                                                                                |
| <a id="external-call-in-transaction"></a>`external-call-in-transaction`                                                                                                                                                                                                        | An external call is awaited inside a database transaction callback, holding the connection and locks until it returns. Move it before the transaction or after commit; side effects cannot roll back.                                                                                                                                                                                           |
| <a id="unbounded-list-query"></a>`unbounded-list-query`                                                                                                                                                                                                                        | A Prisma, TypeORM, Drizzle or pg list query has no `take` or `limit` and its rows are returned from a request handler. Unique-key lookups are skipped; one-hop service findings require contextual mode. A page size taken straight from request input with no upper cap is reported too.                                                                                                       |
| <a id="unbounded-module-cache"></a>`unbounded-module-cache`                                                                                                                                                                                                                    | A module-level or singleton-service `Map`, `Set` or object is filled by dynamic key inside functions and never deleted from, cleared or size-checked. The key space may still be small.                                                                                                                                                                                                         |
| <a id="whole-payload-in-memory"></a>`whole-payload-in-memory`                                                                                                                                                                                                                  | A handler reads a request-chosen path with `fs.readFile`, or a download or stream is buffered whole only to be written out. Stream it with `pipeline`. The `Response` check needs fetch types.                                                                                                                                                                                                  |
| <a id="list-query-overfetch"></a>`list-query-overfetch`                                                                                                                                                                                                                        | A Prisma `findMany` or TypeORM `find` without `select` loads `Json`, `Bytes` or text columns, or relations two levels deep. Column checks need a parseable schema; pages up to 100 rows skip them.                                                                                                                                                                                              |
| <a id="orm-deep-offset"></a>`orm-deep-offset`                                                                                                                                                                                                                                  | A Prisma `skip`, TypeORM, Sequelize, Mongoose, Drizzle or Knex offset, or a pg `OFFSET $n`, takes request input with no upper bound, or is a literal above 10000. The database reads and discards every skipped row; use keyset (cursor) pagination. One-hop service calls and schemas whose limit cannot be read are contextual.                                                               |
| <a id="list-count-per-request"></a>`list-count-per-request`                                                                                                                                                                                                                    | A request handler that pages rows also runs a full count (`count`, `findAndCount`, `countDocuments`, `select count(...)`) and returns the total. Cached and first-page-only counts are skipped; counts filtered by an id column, and counts with the same `where` as a list limited to one page (`take`/`limit`), are contextual. A serial count then page is `count-then-page-serial` instead. |
| <a id="notification-send-in-loop"></a>`notification-send-in-loop`                                                                                                                                                                                                              | A firebase-admin, SendGrid, Expo, OneSignal or SNS send runs once per loop item where the provider has a batch API. nodemailer, web-push, Twilio and SES sends are contextual because their batch shape depends on the content. Providers are recognised from their types.                                                                                                                      |
| <a id="session-memory-store"></a>`session-memory-store`                                                                                                                                                                                                                        | `express-session` or `@fastify/session` is set up without a `store`, so sessions live in process memory: they leak, are lost on restart and are not shared across instances. Pass a shared store such as connect-redis or connect-pg-simple.                                                                                                                                                    |
| <a id="orm-cartesian-include"></a>`orm-cartesian-include`                                                                                                                                                                                                                      | One TypeORM or Sequelize query joins two or more collection relations (`leftJoinAndSelect`, `relations`, `include`), so the rows multiply as the product of their sizes. Load the second collection in its own query (`relationLoadStrategy: 'query'`, Sequelize `separate: true`).                                                                                                             |
| <a id="retry-without-backoff"></a>`retry-without-backoff`                                                                                                                                                                                                                      | A network call is retried in a loop, or axios-retry is set up, with no wait between attempts. Add exponential backoff with jitter. axios-retry without `retryDelay` is contextual.                                                                                                                                                                                                              |
| <a id="json-roundtrip-clone"></a>`json-roundtrip-clone`                                                                                                                                                                                                                        | A value is deep-copied with `JSON.parse(JSON.stringify(...))` in a request handler or loop. Use `structuredClone`, or copy only the fields you change.                                                                                                                                                                                                                                          |
| <a id="mongoose-aggregate-uncast-id"></a>`mongoose-aggregate-uncast-id`                                                                                                                                                                                                        | A Mongoose `aggregate()` `$match` compares `_id` to a plain string. Aggregation does not cast, so the stage matches nothing; wrap the value in `new Types.ObjectId(id)`. Skipped when a schema declares a String `_id`.                                                                                                                                                                         |
| <a id="mongoose-hydrate-for-to-object"></a>`mongoose-hydrate-for-to-object`                                                                                                                                                                                                    | A Mongoose `find`, `findOne` or `findById` result is only null-checked and converted with `.toObject()` or `.toJSON()`. Append `.lean()` to skip hydration. Skipped when a schema customizes `toObject` or `toJSON`.                                                                                                                                                                            |
| <a id="express-missing-compression"></a>`express-missing-compression`                                                                                                                                                                                                          | An Express app calls `listen` and no project file imports `compression`. Reported as contextual: a reverse proxy may already compress responses. Test files are skipped.                                                                                                                                                                                                                        |
| <a id="heavy-media-in-request-handler"></a>`heavy-media-in-request-handler`                                                                                                                                                                                                    | `sharp` image processing, Puppeteer `page.pdf()` or `html-pdf` rendering runs inside a request handler. Move it to a job queue or worker thread. Contextual, because offloading changes the API.                                                                                                                                                                                                |
| <a id="react-missing-cleanup"></a>`react-missing-cleanup`                                                                                                                                                                                                                      | An effect starts a global listener, interval, socket or endless subscription and returns no cleanup, so it leaks on every remount.                                                                                                                                                                                                                                                              |
| <a id="react-index-as-key"></a>`react-index-as-key`                                                                                                                                                                                                                            | A list item uses the map index as its React key, which breaks reconciliation when items are inserted or reordered.                                                                                                                                                                                                                                                                              |
| <a id="react-fetch-in-effect-no-abort"></a>`react-fetch-in-effect-no-abort`                                                                                                                                                                                                    | A fetch in an effect has no AbortController or cleanup, so dependency changes can race and apply stale results.                                                                                                                                                                                                                                                                                 |
| <a id="react-inline-object-in-jsx-prop"></a>`react-inline-object-in-jsx-prop`                                                                                                                                                                                                  | An inline object literal is passed to a memo() component, creating a new reference each render and defeating the memo.                                                                                                                                                                                                                                                                          |
| <a id="angular-subscribe-without-cleanup"></a>`angular-subscribe-without-cleanup`                                                                                                                                                                                              | An RxJS subscription in a component has no completing operator or ngOnDestroy unsubscribe and keeps running after destruction.                                                                                                                                                                                                                                                                  |
| <a id="angular-default-change-detection"></a>`angular-default-change-detection`                                                                                                                                                                                                | An Angular component uses default change detection instead of OnPush, so its subtree is re-checked on every event.                                                                                                                                                                                                                                                                              |
| <a id="vue-watch-missing-cleanup"></a>`vue-watch-missing-cleanup`                                                                                                                                                                                                              | onMounted registers a global listener, timer or observer with no unmount cleanup.                                                                                                                                                                                                                                                                                                               |
| <a id="vue-v-for-missing-key"></a>`vue-v-for-missing-key`                                                                                                                                                                                                                      | A list rendered with h() has no key prop, forcing inefficient patching.                                                                                                                                                                                                                                                                                                                         |
| <a id="dom-layout-thrashing"></a>`dom-layout-thrashing`                                                                                                                                                                                                                        | A loop reads layout metrics and mutates DOM styles or classes, forcing a reflow on each iteration.                                                                                                                                                                                                                                                                                              |
| <a id="dom-listener-without-cleanup"></a>`dom-listener-without-cleanup`                                                                                                                                                                                                        | A window or document listener uses an inline function with no AbortSignal or once, so it can never be removed.                                                                                                                                                                                                                                                                                  |
| <a id="dom-unthrottled-scroll-resize"></a>`dom-unthrottled-scroll-resize`                                                                                                                                                                                                      | A scroll, resize, mousemove, wheel or touch listener runs unthrottled work (or is non-passive) on the main thread.                                                                                                                                                                                                                                                                              |
| <a id="frontend-barrel-heavy-import"></a>`frontend-barrel-heavy-import`                                                                                                                                                                                                        | A client module imports the whole of lodash or moment instead of subpaths or a lighter library.                                                                                                                                                                                                                                                                                                 |
| <a id="sql-select-star-in-query"></a>`sql-select-star-in-query`                                                                                                                                                                                                                | A raw SQL query selects every column with SELECT * instead of the columns it needs.                                                                                                                                                                                                                                                                                                             |
| <a id="sequential-http-in-loop"></a>`sequential-http-in-loop`                                                                                                                                                                                                                  | Independent HTTP requests are awaited one at a time inside a loop.                                                                                                                                                                                                                                                                                                                              |
| <a id="check-then-update-race"></a>`check-then-update-race`                                                                                                                                                                                                                    | A Mongoose or Sequelize document's numeric field is read, changed in JavaScript and saved without a transaction, losing concurrent updates.                                                                                                                                                                                                                                                     |
| <a id="payment-missing-idempotency-key"></a>`payment-missing-idempotency-key`                                                                                                                                                                                                  | A Stripe call that moves money has no idempotency key, so a retry can charge or pay out twice.                                                                                                                                                                                                                                                                                                  |
| <a id="webhook-missing-idempotency-check"></a>`webhook-missing-idempotency-check`                                                                                                                                                                                              | A webhook route inserts rows without first checking whether the event was already processed.                                                                                                                                                                                                                                                                                                    |

Source diagnostics include a one-based line and column. Repeat `--ignore RULE` to omit specific JS/TS rules from a run. Keep your project's own type check in CI.

For an intentionally repeated operation, attach the review to that specific site. The comment must be on its own line immediately before the diagnostic line, name one exact rule and include a reason.

```ts
// loadwise-reviewed pg-query-in-loop -- Each iteration measures a separate query-plan sample.
await client.query(statement);
```

The site remains available with `--include-contextual`. Source comments cannot lower either CI contract, a configured row-scope check, a Prisma transaction-client escape or a Prisma read-modify-write finding. Test, seed and script context applies to Prisma dependent writes and Drizzle whole-table writes in test sources. It also applies to per-item query rules, index rules, serial awaits in literals, Redis `KEYS` and pure-JavaScript password hashing in test, seed and operator-tooling sources (`scripts`, `seeds`, `prisma/seed.ts`, `*.seed.ts`, deployment, migrations). Application code, tests and scripts still participate in source analysis.

Watch mode uses TypeScript 6.0.3. Watch a single project while editing. With `--watch --json`, each completed scan writes one JSON line. Ctrl+C stops the watcher. One-shot runs support project references.

One-shot checks pick the compiler automatically. On Node.js 22.13+ with the optional native package for your platform, they use Microsoft's Go-based TypeScript 7.1 beta compiler. It is 2-4 times faster on large projects and reports the same findings. If TypeScript 7 rejects the project configuration, for example `baseUrl` or `moduleResolution: "node10"`, the check uses TypeScript 6.0.3 and prints one note on stderr. `--engine native` (alias `--native`) requires TypeScript 7 and reports incompatible configuration as exit 2. `--engine js` always uses TypeScript 6.0.3. `perf --json` names the engine used in `engine` (`"js"` or `"native"`), and a silent fall-back from the native engine prints a note on stderr. [TypeScript native compiler](https://github.com/microsoft/typescript-go)

Install the application's driver declarations and generate its Prisma client before checking. Result-shape checks target simple literal PostgreSQL reads and supported Prisma model delegates. Unresolved types, wrappers and deferred callbacks can hide findings. Repeated calls can be intentional, for example retries and ordered writes.

## ORM and query integrity checks

The JS/TS checker resolves declarations from installed drivers and generated clients. Install the dependencies used by the project, including type declarations. When resolution is incomplete, some calls will be missed. The rules run locally against source and recorded evidence.

| Library         | Source patterns covered                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prisma          | Executed per-item operations, fetching rows only to count, filter, sort or take the first, dependent creates, transaction client use and stale numeric overwrites.              |
| Drizzle ORM     | Executed fluent queries on the PostgreSQL, MySQL and SQLite core APIs, per-item prepared executions, and direct mutations with an absent or demonstrably ineffective predicate. |
| TypeORM         | Repository reads inside repeated execution and simple `find` or `findBy` calls that load entities only for their count.                                                         |
| Sequelize       | Model reads inside repeated execution and immediate counts of simple `findAll` results.                                                                                         |
| Mongoose        | Consumed model queries including common `lean` and `exec` chains, plus immediate counts for simple equivalent filters.                                                          |
| Knex and Kysely | Consumed Knex builders and Kysely SELECT execution methods inside repeated work. Simple single-table queries materialized only to read their length.                            |
| node-postgres   | Per-item queries, client-side result processing, pool handoff and transaction commands issued through a pool.                                                                   |

<a id="drizzle-query-in-loop"></a><a id="orm-query-in-loop"></a><a id="typeorm-transaction-in-loop"></a><a id="orm-count-materialization"></a><a id="typeorm-existence-materialization"></a><a id="typeorm-wide-projection"></a>`orm-query-in-loop`, `drizzle-query-in-loop` and `orm-count-materialization` preserve the distinction between building a lazy statement and executing it. Counts with pagination, grouping, joins, hooks or scopes need particular care. TypeORM checks also identify entity reads used only for existence (`typeorm-existence-materialization`), unused wide columns in a direct DTO projection (`typeorm-wide-projection`), and a loop calling a local private helper that starts a transaction (`typeorm-transaction-in-loop`). Before changing a projection or an existence check, verify entity-load side effects. For per-row transactions, check rollback, ordering and error reporting before batching. The adapters recognize specific typed APIs. Custom methods with the same name, raw queries and wrappers often have different semantics.

| Integrity rule                                                                    | What to review                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="pg-transaction-on-pool"></a>`pg-transaction-on-pool`                       | A standalone transaction-control statement is sent to a typed pool. Use the same checked-out client for the whole transaction and release it in `finally`.                                                                                                                                                                                                                                                                                  |
| <a id="prisma-transaction-client-escape"></a>`prisma-transaction-client-escape`   | A direct model operation uses the same outer client that opened an interactive transaction. Verify that the operation belongs inside that transaction.                                                                                                                                                                                                                                                                                      |
| <a id="typeorm-transaction-client-escape"></a>`typeorm-transaction-client-escape` | An awaited write inside a TypeORM transaction goes through a repository or manager that is not bound to it, so it autocommits on another pooled connection, is not rolled back with the transaction and can block on its locks. Use the transaction's manager (`manager.getRepository(Entity)`).                                                                                                                                            |
| <a id="prisma-dependent-writes"></a>`prisma-dependent-writes`                     | Adjacent creates pass a value from the first record into the next write. Explicit single-key nested `connect` can use a custom unique field when generated types confirm a relation. Direct scalar assignments currently recognize `parent.id` going into a field ending in `Id` or `_id`. Other scalar foreign-key conventions can be missed. If both writes must succeed together, consider a nested write or an appropriate transaction. |
| <a id="prisma-read-modify-write"></a>`prisma-read-modify-write`                   | A direct read of one row feeds a numeric update of the same field and key. Review atomic arithmetic, an optimistic version check or serializable execution with retries.                                                                                                                                                                                                                                                                    |
| <a id="find-then-create-race"></a>`find-then-create-race`                         | A Prisma or TypeORM lookup by one key is followed in the same function by an insert with the same key, and the schema shows no unique constraint on it. Add the constraint and catch the violation (Prisma P2002, Postgres 23505) or use `upsert` / `ON CONFLICT`. Without a readable schema the finding is contextual; serializable transactions, locks and handled duplicates are skipped.                                                |
| <a id="prisma-distinct-in-memory"></a>`prisma-distinct-in-memory`                 | `findMany({ distinct })` reads every matching row and de-duplicates in Prisma's query engine, not with SQL `DISTINCT`. Use `groupBy` or a raw `SELECT DISTINCT`. Quiet when the `nativeDistinct` preview feature is enabled.                                                                                                                                                                                                                |
| <a id="prisma-relation-count-in-list"></a>`prisma-relation-count-in-list`         | A paged `findMany` selects `_count` of a relation, which Prisma computes over the whole related table. Fetch the page, then `groupBy` for the page ids and merge the counts.                                                                                                                                                                                                                                                                |
| <a id="typeorm-load-then-save"></a>`typeorm-load-then-save`                       | A repository entity is loaded only to change a few fields and then `save()`d, costing a SELECT, an UPDATE and a transaction. Use `update()` or `increment()`; entity listeners and subscribers for update will not run.                                                                                                                                                                                                                     |
| <a id="guard-query-per-request"></a>`guard-query-per-request`                     | A guard or similar per-request hook runs a database query before every handler. Cache the lookup with a short TTL and explicit invalidation, or carry the claims in the token.                                                                                                                                                                                                                                                              |
| <a id="drizzle-unfiltered-write"></a>`drizzle-unfiltered-write`                   | An executed update/delete has no effective predicate in a recognized direct chain. An intentional whole-table maintenance operation can legitimately match.                                                                                                                                                                                                                                                                                 |

For Prisma, building an array of lazy queries alone is quiet. A sequential `await` inside a loop can trigger the rule. Same-tick `findUnique` callbacks can use Prisma's own batching, so these are left to runtime traces. [Prisma Client reference](https://www.prisma.io/docs/orm/reference/prisma-client-reference#prismapromise-behavior) · [Prisma transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions) · [node-postgres transactions](https://node-postgres.com/features/transactions) · [Drizzle conditional filters](https://orm.drizzle.team/docs/guides/conditional-filters-in-query)

### Project-defined access policy

Place `backend-perf.policy.json` beside the selected project config, or pass `--policy path/to/file.json`. Explicit source-file checks discover the policy in the working directory. A policy can use just the sections the project needs (`prismaScopes`, `drizzleScopes`, `parallelReads`, and `fireAndForget`, a list of helper names that `floating-promise` accepts without an await). Duplicate JSON keys within the same object produce a configuration error. [Example policy](examples/query-policy.json)

### Async work and sorting

| Rule                                                                                | When it reports                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="promise-combinator-serial-await"></a>`promise-combinator-serial-await`       | A built-in `Promise.all` or `Promise.allSettled` receives an array of two or more already-awaited calls with known promise types. Starting them together changes which calls run after a failure. With `allSettled`, it also changes how rejections are returned.                                                                                                                              |
| <a id="known-reads-awaited-serially"></a>`known-reads-awaited-serially`             | Two adjacent awaited reads come from a project-configured `parallelReads` group and the second call is independent of the first result in a supported straight-line shape.                                                                                                                                                                                                                     |
| <a id="numeric-sort-for-extreme"></a>`numeric-sort-for-extreme`                     | A numeric comparison sort on a private copy, or a nonmutating numeric sort, is used only to retrieve its first or last value. A single-pass extreme can use constant extra space. Preserve empty input, NaN, sparse inputs and signed-zero semantics when applicable.                                                                                                                          |
| <a id="count-then-page-serial"></a>`count-then-page-serial`                         | A `count()` and a page query with the same filter run one after the other (TypeORM query builder or repository, Prisma). Use `getManyAndCount()` or `findAndCount()`, or start both Prisma calls together with `Promise.all` outside an interactive transaction.                                                                                                                               |
| <a id="typeorm-unused-count"></a>`typeorm-unused-count`                             | A typed TypeORM `findAndCount()`, `findAndCountBy()` or `getManyAndCount()` call returns rows and a count but the awaited destructuring only keeps the rows. Use `find()`, `findBy()` or `getMany()` with the same filters and paging when the count is unnecessary.                                                                                                                           |
| <a id="prisma-count-for-existence"></a>`prisma-count-for-existence`                 | An awaited numeric Prisma `count()` with no options or only `where` is used solely as a zero-or-nonzero test. Read one row with the same filter and a small projection when only existence matters.                                                                                                                                                                                            |
| <a id="await-before-early-exit"></a>`await-before-early-exit`                       | An awaited ORM or HTTP read is followed directly by an `if` that returns or throws without using the result, so a request the guard rejects still pays the round trip. Writes, `OrThrow` reads and POSTs are left alone. The fix moves the guard above the await only when it has no calls and reads only parameters and earlier constants.                                                    |
| <a id="floating-promise"></a>`floating-promise`                                     | A promise-returning call is a bare statement in an async function or request handler, or `array.forEach(async ...)` runs awaits nobody waits for. Returning, awaiting, using `void`, or attaching a rejection callback suppresses the bare-call warning. Omitted or nullish callbacks do not handle rejections. Test files and helpers listed under `fireAndForget` in the policy are skipped. |
| <a id="discarded-error-result"></a>`discarded-error-result`                         | A call discards a typed `fp-ts` `Either` or `neverthrow` `Result`. This includes async calls, standalone `await` and explicit `void`. Check the failure branch or return the result to a caller that handles it.                                                                                                                                                                               |
| <a id="promise-return-escapes-catch"></a>`promise-return-escapes-catch`             | An async function returns a typed promise directly from the `try` block of a `try`/`catch`. A rejection can bypass that catch. Use `return await` when the catch owns the failure.                                                                                                                                                                                                             |
| <a id="return-in-finally"></a>`return-in-finally`                                   | A return in `finally` can replace an earlier return value or suppress a thrown error. Keep cleanup in `finally` and return from `try`, `catch`, or after the statement.                                                                                                                                                                                                                        |
| <a id="return-newline"></a>`return-newline`                                         | A line break immediately after `return` ends the statement before an apparent object or parenthesized return value. Start the expression on the same line as `return`.                                                                                                                                                                                                                         |
| <a id="async-route-unhandled-rejection"></a>`async-route-unhandled-rejection`       | An async Express 4 route handler awaits outside a try/catch and takes no `next`, so a rejection skips the error middleware and the request hangs. Silent on Express 5 and with express-async-errors, express-async-handler or a wrapping call; an unknown Express version is contextual. Fix (review): wrap the body in try/catch and pass the error to `next`.                                |
| <a id="async-callback-unhandled-rejection"></a>`async-callback-unhandled-rejection` | An async callback given to `.on`/`.once`, a timer, `process.nextTick` or `cron.schedule` awaits outside a try/catch; nothing handles its promise, so a rejection crashes Node 15+. Fix (review): wrap the body in try/catch that logs the error.                                                                                                                                               |
| <a id="stream-pipe-unhandled-error"></a>`stream-pipe-unhandled-error`               | `.pipe()` on a Node stream with no `error` listener and no `pipeline`/`finished` in the function, so a stream error crashes the process or leaks the file and socket. RxJS pipes are skipped; a stream known only by its name is contextual. Fix (review): `await pipeline(...)` from `node:stream/promises`.                                                                                  |
| <a id="json-parse-unguarded"></a>`json-parse-unguarded`                             | `JSON.parse` of request, queue-message, file, fetch, storage or environment input outside a try/catch. Framework handlers that turn a throw into a 500, and startup parses, are contextual.                                                                                                                                                                                                    |
| <a id="request-number-unvalidated"></a>`request-number-unvalidated`                 | `Number`, `parseInt`, `parseFloat` or unary `+` of raw request input reaches a query, `slice`/`limit`/`skip`/`take`, an index or kept arithmetic with no NaN or range check. Schema-validated values, Nest DTOs and pipes are skipped. Fix (review): a 400 guard after the declaration.                                                                                                        |
| <a id="drizzle-write-preflight"></a>`drizzle-write-preflight`                       | An existence check immediately precedes a write on the same key. Review the database constraint or affected-row count alongside the intended error response when requests race.                                                                                                                                                                                                                |
| <a id="drizzle-last-insert-id"></a>`drizzle-last-insert-id`                         | A MySQL insert is followed by a separate query for the last generated ID. Review using the insert result directly, especially when the database handle uses a connection pool.                                                                                                                                                                                                                 |
| <a id="repeated-workbook-decode"></a>`repeated-workbook-decode`                     | Sibling awaits pass the same input to ExcelJS workbook decoding directly or through same-file private methods or functions. Share a parsed workbook when its readers can safely use the same state.                                                                                                                                                                                            |

The example policy declares that `fetchUser` and `fetchPosts` from `@app/reads` may start together. Only group operations whose ordering, shared connections, rate limits and failure effects your project has reviewed. With that declaration, the checker can flag the pair below. Ordinary adjacent calls such as `saveSettings()` followed by `reloadSettings()` carry no such contract.

```ts
import { fetchUser, fetchPosts } from '@app/reads';

async function load() {
  const user = await fetchUser();
  const posts = await fetchPosts();
  return { user, posts };
}
```

The CLI reports review candidates and leaves source files untouched. The scheduling and sorting rules were implemented in this package. The lockfile test checks the full resolved graph for ESLint and the referenced plugins. Design references include the documented ordering limits of sequential-await analysis, ESLint's loop examples and Unicorn's numeric-sort and Promise rules. [Parallelize](https://github.com/braeden/eslint-plugin-parallelize) · [ESLint](https://eslint.org/docs/latest/rules/no-await-in-loop) · [Unicorn](https://github.com/sindresorhus/eslint-plugin-unicorn) · [Perf Fiscal](https://github.com/ruidosujeira/perf-fiscal)

## Inline fixes

Where a rule has a safe rewrite for the flagged code, the finding carries a concrete change. With `--json`, it is `fix = { changes: [{ file, line, before, after, create? }], note? }`. Text output prints the change as a diff. A change with `create` holds a whole new file, for example a migration that adds an index. Rules with no safe rewrite fall back to a generic example.

```sh
npx loadwise perf -p tsconfig.json --fix         # asks y/n/a/q for each fix; needs a terminal
npx loadwise perf -p tsconfig.json --fix --yes   # applies eligible fixes without asking
```

`--fix` answers are **y**es, **n**o, **a**ll remaining and **q**uit. Without a terminal it requires `--yes`. `--fix` cannot be combined with `--watch`, or with `--json` except with `--only`, and `--yes` is valid only with `--fix`. A fix applies only where the original lines still exist, so code that changed since the scan is refused and a change already in the file is reported as already applied. A fix never overwrites an existing file. Like `loadwise fix`, it adds a why-comment above each fixed statement and formats the changed lines with the project's Prettier; `--no-comments` and `--no-format` turn these off. Review the diff and run your tests afterwards. Rewrites that narrow a whole-table Drizzle update to rows with differing values require individual review because the change can affect locking, triggers and affected-row counts. Upload size limits also require individual review. The 10 MiB example can reject valid uploads, so check the endpoint's file requirements and any existing gateway or Multer limits before applying it.

## Apply fixes by id

Every finding has a stable `id`, shown as `[rule-id #id]` in text output. It hashes the rule, the file and the flagged line's text, so it survives edits above the finding. JSON findings also carry `fixable` and, when available, `fix`. `prisma-count-for-existence` findings may carry `idField`, the model's single primary-key field, which the fix uses for its `select`. To apply chosen fixes without a prompt:

```sh
npx loadwise perf --fix --only a1b2c3d4e5f6,0f9e8d7c6b5a --json   # prints { applied, alreadyApplied, failed }
```

An unknown id, a finding with no fix, or a fix whose code changed since the scan is listed in `failed`, and the exit code is 2. An id whose change an earlier id in the same run already made, such as a shared `Set`, is listed in `alreadyApplied` and is not a failure. To dismiss a false positive, add the `// loadwise-reviewed <rule-id> -- <reason>` comment described under Source checks.

## Check only the lines you changed

```sh
npx loadwise perf --staged                       # lines added or modified in the git index
npx loadwise perf --changed-since origin/main    # lines changed in the working tree since a ref
npx loadwise perf -p tsconfig.json --staged --json
```

Both flags report only findings on changed lines, each with its id, the exact `--fix --only <id>` command when an automatic fix exists, and the `// loadwise-reviewed <rule-id> -- <reason>` comment that dismisses it. `--json` keeps the usual shape, filtered. The exit code is 1 when findings remain. With no changed JavaScript or TypeScript files the command exits 0 before TypeScript loads. Only the changed files are analyzed as roots, and their imports still resolve through the tsconfig; `schema.prisma` findings are not part of this mode. Files that are untracked count as fully changed with `--changed-since`. Analysis reads the working tree, so a file with unstaged edits can report lines that differ from the staged version. The flags cannot be combined with explicit files, `--watch` or `--fix`.

## Migration safety

`npx loadwise perf migrations` reads Prisma, Drizzle, TypeORM, Knex and Sequelize migrations (SQL or code) and flags statements that lock or rewrite a table. It reads files only. `--dialect postgres|mysql` selects the rule set, `--json` for structured output and `--ignore RULE` to skip a rule.

| Rule                                                                                                                                                                                                                                    | What it flags                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="migration-index-not-concurrent"></a><a id="migration-concurrent-in-transaction"></a>`migration-index-not-concurrent`, `migration-concurrent-in-transaction`                                                                      | A PostgreSQL index built without `CONCURRENTLY`, or `CONCURRENTLY` inside a transaction that cannot run it.                                 |
| <a id="migration-not-null-without-default"></a><a id="migration-volatile-default"></a>`migration-not-null-without-default`, `migration-volatile-default`                                                                                | A NOT NULL column added without a default (fails once rows exist), or a volatile default that rewrites the table.                           |
| <a id="migration-column-type-rewrite"></a><a id="migration-table-rewrite-command"></a>`migration-column-type-rewrite`, `migration-table-rewrite-command`                                                                                | A column type change or command (`VACUUM FULL`, `CLUSTER`, `REINDEX`) that rewrites the table.                                              |
| <a id="migration-set-not-null-scan"></a><a id="migration-constraint-not-valid"></a><a id="migration-constraint-without-index"></a>`migration-set-not-null-scan`, `migration-constraint-not-valid`, `migration-constraint-without-index` | Full-table validation scans, constraints that should be added `NOT VALID` first, and constraints that build an index while blocking writes. |
| <a id="migration-breaking-drop"></a><a id="migration-breaking-rename"></a>`migration-breaking-drop`, `migration-breaking-rename`                                                                                                        | Dropping or renaming a column or table that running application code may still use.                                                         |
| <a id="migration-missing-lock-timeout"></a>`migration-missing-lock-timeout`                                                                                                                                                             | A locking statement with no `lock_timeout`.                                                                                                 |
| <a id="migration-mysql-table-copy"></a><a id="migration-mysql-lock-unspecified"></a>`migration-mysql-table-copy`, `migration-mysql-lock-unspecified`                                                                                    | MySQL changes that copy the table or leave the lock level unspecified.                                                                      |
| <a id="migration-unparsed"></a>`migration-unparsed`                                                                                                                                                                                     | A statement the checker could not read. Review it by hand.                                                                                  |

Only new migrations fail the run. Older migrations are contextual: counted, listed with `--include-contextual`, and never exit 1.

**CI recipe.** Enforce only what the branch adds or changes (files modified since the merge base, plus untracked files). Use a full-history checkout (`fetch-depth: 0`) so the ref resolves.

```sh
npx loadwise perf migrations --changed-since origin/main
```

**Baseline workflow.** For a project with existing migrations, accept them once and enforce the rest.

```sh
npx loadwise perf migrations --write-baseline   # writes backend-perf.migrations-baseline.json
npx loadwise perf migrations                    # new migrations fail; baselined ones do not
```

Commit the baseline. `--baseline FILE` reads or writes another path. Exit codes match the source checks: 0 passed, 1 findings in enforced migrations, 2 invalid input.

## API contract safety

`npx loadwise perf contracts [--changed-since REF] [--json]` compares the working tree with the merge base of `REF` (default `HEAD`) and flags changes that break API clients. `loadwise check --changed-since REF` includes the same findings in the performance report. Both commands respect workspace selection, ignored paths and rules, configured rule levels, and minimum impact. Visible breaking changes fail by default. Rules set to warn appear in the report and do not fail the check. Invalid input exits 2. Use a full-history checkout (`fetch-depth: 0`) so the ref resolves.

It compares three kinds of source:

- **OpenAPI and Swagger JSON** (`openapi.json`, `swagger.json`). YAML documents are skipped with a note, because no YAML parser ships with loadwise; commit or check a JSON export instead.
- **GraphQL SDL** (`*.graphql`, `*.gql`, for example the `schema.gql` a code-first server emits). Query documents are skipped.
- **NestJS classes** used as `@Body()` types or as controller return types (also `@ApiResponse({ type })`), found in `*.controller.ts` and read from the file that declares them (relative imports only). Only property names, `?`, `@IsOptional()` and the written type text are compared.

| Rule                                                        | What it flags                                                                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| <a id="api-removed-operation"></a>`api-removed-operation`   | An OpenAPI path and method, or a GraphQL `Query`, `Mutation` or `Subscription` field, that no longer exists.                |
| <a id="api-removed-field"></a>`api-removed-field`           | A response field, GraphQL type, field, argument or union member, or a DTO property returned to clients, that was removed.   |
| <a id="api-required-input"></a>`api-required-input`         | A request field, parameter, GraphQL argument or input field that is new and required, or changed from optional to required. |
| <a id="api-type-changed"></a>`api-type-changed`             | A field or parameter whose type changed, or a GraphQL type that became nullable (output) or non-null (input).               |
| <a id="api-enum-value-removed"></a>`api-enum-value-removed` | An enum value or string-literal option that requests (or, in GraphQL, any client) can no longer use.                        |

Removals point at the line in the old version (the message says so); every other finding points at the new line. A new version next to the old one (`/v2/users` added while `/v1/users` stays) breaks nothing and is not flagged. A removed request property is flagged only when the project builds a `ValidationPipe` with `forbidNonWhitelisted: true`, because only then do clients that still send it get a 400. Properties inherited from a base class in a relative import count as the class's own.

```sh
npx loadwise perf contracts --changed-since origin/main
npx loadwise check --changed-since origin/main
```

## Schema-aware index checks

The source checker reads the project's ORM schema (Prisma, Drizzle, TypeORM, Sequelize, Mongoose) and compares declared indexes with the queries it finds.

| Rule                                                              | What it flags                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="index-missing-filter"></a>`index-missing-filter`           | A query filters on a column that no index leads with.                                                                                                                                                                                                                                                                                                             |
| <a id="index-missing-order"></a>`index-missing-order`             | A query orders by columns no index can serve in that order.                                                                                                                                                                                                                                                                                                       |
| <a id="index-missing-foreign-key"></a>`index-missing-foreign-key` | A foreign key column has no index.                                                                                                                                                                                                                                                                                                                                |
| <a id="index-unusable-pattern"></a>`index-unusable-pattern`       | A predicate such as a leading-wildcard `LIKE` cannot use an ordinary index.                                                                                                                                                                                                                                                                                       |
| <a id="index-unusable-expression"></a>`index-unusable-expression` | A function or expression on an indexed column prevents the index from being used.                                                                                                                                                                                                                                                                                 |
| <a id="index-redundant-prefix"></a>`index-redundant-prefix`       | An index repeats the leading columns of a longer index on the same table (or duplicates it), adding write and memory cost while serving no read the longer one cannot; drop the shorter one (for Sequelize, remove it from the model too, since `sync({ alter: true })` recreates it). An index inherited from a base entity is reported once, at the base class. |

Each suggested index carries one explicit name, used both in the ORM snippet (`@@index([a, b], map: "<name>")`, `@Index('<name>', ['a', 'b'])`, `{ name: '<name>', fields: [...] }`, `index('<name>')`, `schema.index({ a: 1 }, { name: '<name>' })`) and in the `CREATE INDEX CONCURRENTLY` statement for a live database, so building it by hand and then generating a migration does not create a duplicate. A fix that adds an index to a Prisma, TypeORM or Drizzle model says to generate a migration for it.

Pass `--schema snapshot.json` (written by `db --schema-snapshot`) to refine them with real table sizes and the measured round trip, which also feeds the Impact line of `*-query-in-loop` findings. Without a snapshot, the checks run from the source schema alone.

## Polyglot source checks

`npx loadwise perf polyglot src` accepts directories or individual `.py`, `.go`, `.java`, `.cs` and `.rs` files. It uses the optional ast-grep native binary and its syntax-tree patterns. Language-specific aliases and wrappers can fall outside a pattern. [ast-grep](https://ast-grep.github.io/)

Performance and maintainability scans retry files when the bundled parser rejects a Java marker annotation before varargs or a C# 14 conditional member assignment (`=`) in a simple identifier chain. The retry uses a position-preserving copy in memory and still fails if the parser reports a syntax error.

| Rule                                                                        | Example in a loop                                                                                                          |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| <a id="python-copy-growing-list"></a>`python-copy-growing-list`             | A list initialized to `[]` is repeatedly assigned `items = items + [value]` in a simple loop.                              |
| <a id="python-sync-requests-in-async"></a>`python-sync-requests-in-async`   | A `requests.get`, `post`, `put`, `patch`, `delete` or `request` call inside an `async def` function blocks the event loop. |
| <a id="python-blocking-sleep-in-async"></a>`python-blocking-sleep-in-async` | `time.sleep(...)` inside an `async def` function, in a module that imports `time`.                                         |
| <a id="python-fixed-regex-in-loop"></a>`python-fixed-regex-in-loop`         | `re.compile("pattern")` with a string literal, in a module that imports `re`.                                              |
| <a id="go-fixed-regexp-in-loop"></a>`go-fixed-regexp-in-loop`               | `regexp.Compile("pattern")` or `regexp.MustCompile("pattern")`                                                             |
| <a id="java-fixed-regex-in-loop"></a>`java-fixed-regex-in-loop`             | `Pattern.compile("pattern")`                                                                                               |
| <a id="csharp-fixed-regex-in-loop"></a>`csharp-fixed-regex-in-loop`         | `new Regex("pattern")`                                                                                                     |
| <a id="rust-fixed-regex-in-loop"></a>`rust-fixed-regex-in-loop`             | `Regex::new("pattern")`                                                                                                    |

## Trace checks in other languages and databases

Supply a local **OTLP/JSON trace export** with `resourceSpans → scopeSpans → spans`. An OpenTelemetry Collector with a file export can produce this format. The CLI accepts one export object per invocation. For a collector output containing multiple JSON lines, pass the relevant export object for the request. Spans split across separate invocations count independently.

Try `npx loadwise perf traces node_modules/@loadwise/cli/examples/repeated-db.otlp.json`. The example reports five similar MongoDB operations under one parent. The trace rules use current and legacy database attributes and deduplicate span IDs.

| Rule                                                        | Evidence and interpretation                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="repeated-db-span"></a>`repeated-db-span`             | Five similar sibling DB calls by default, grouped by resource, trace, parent and recorded database target. SQL statements, query summaries, operation/collection pairs and recognized DynamoDB `GetItem` events can provide signatures. Namespace-only MongoDB or DynamoDB groups call for inspection of the actual predicates.                                                                                                               |
| <a id="redis-keys-scan"></a>`redis-keys-scan`               | One Redis or Valkey `KEYS` command can scan the keyspace. For incremental iteration, account for duplicates and keys changing between `SCAN` calls.                                                                                                                                                                                                                                                                                           |
| <a id="redis-repeated-read"></a>`redis-repeated-read`       | Repeated sibling `GET` or `HGET` calls. Consider compatible multi-key reads or bounded pipelining with appropriate cluster slots, ordering and error handling. Recognized pipeline children are excluded.                                                                                                                                                                                                                                     |
| <a id="redis-incr-then-expire"></a>`redis-incr-then-expire` | An `incr`, `incrby` or `hincrby` followed by `expire` or `pexpire` on the same key and client takes two round trips and is not atomic: a crash between them leaves the counter without a TTL. Send both in one `multi()` (with `NX` on Redis 7+) or a Lua script.                                                                                                                                                                             |
| <a id="duplicate-key-read"></a>`duplicate-key-read`         | Two or more reads with the same observable lookup, database target and recorded scalar context under one parent. The comparison accepts application-defined context keys. Supported evidence includes a concrete Redis `GET` key or a narrow SQL equality lookup with its bound parameter. Masked targets, ambiguous context, observed writes, transactions or failed calls suppress the suggestion where identity or freshness is uncertain. |

Matching keys in two reads are a reason to consider **request-local** reuse when authorization, freshness and ordering allow it. Keep existing telemetry redaction. A redacted key can still support a batching finding. Reports contain span IDs and counts and omit raw SQL, parameters and keys. Check `scannedSpans` and `eligibleDbSpans` when interpreting a clean result. Sampling, missing parents, different literal values and coarse summaries affect grouping. [OpenTelemetry database spans](https://opentelemetry.io/docs/specs/semconv/db/database-spans/) · [OTLP JSON encoding](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding)

## Executed query plans

Feed the CLI a JSON file from PostgreSQL `EXPLAIN (ANALYZE, FORMAT JSON)` or MongoDB `explain("executionStats")`. For example, run `npx loadwise perf plan node_modules/@loadwise/cli/examples/postgres-plan.json`. The checker reads the file locally. PostgreSQL's `ANALYZE` option executes the statement when you collect the plan. [PostgreSQL EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html) · [MongoDB explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)

| Observed work                                                                                                  | Threshold and review                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="pg-sequential-scan"></a><a id="mongo-collection-scan"></a>`pg-sequential-scan`, `mongo-collection-scan` | At least 1,000 examined and at least 100 examined per returned record, treating zero returns as one for this ratio. Review selectivity and available indexes. PostgreSQL totals use the reported per-loop averages.                                   |
| <a id="pg-disk-sort"></a><a id="mongo-disk-sort"></a>`pg-disk-sort`, `mongo-disk-sort`                         | At least 1,024 KiB of disk use by a PostgreSQL sort participant, including a reported incremental-sort group peak, or at least 1 MiB of spill or eight spills on a MongoDB sort. Check whether earlier filtering or an index can reduce sorting work. |
| <a id="pg-deep-offset"></a><a id="mongo-deep-skip"></a>`pg-deep-offset`, `mongo-deep-skip`                     | At least ten times as many entries walked as returned and at least 10,000 skipped per execution. For sequential pages, keyset pagination needs a stable ordering with a unique tie-breaker.                                                           |

Results include the stage path and observed counts. PostgreSQL and MongoDB planner estimates alone return exit 2. MongoDB coverage includes classic executed query stages and selected slot-based scan/filter and skip shapes. Unsupported layouts return an input error where a scan cannot be attributed.

## Database inspection (optional)

`npx loadwise perf db` is the only command that connects to a database. Point it at a staging or read replica database, never a primary you cannot afford to touch. It uses the project's own `pg`, `mysql2` or `mongodb` package.

The connection comes from the environment, never a flag: `DATABASE_URL` (or the variable named by `--url-env`), else `DB_HOST`, `DB_PORT`, `DB_USER` or `DB_USERNAME`, `DB_PASSWORD` and `DB_NAME` or `DB_DATABASE`. `--env-file FILE` reads those variables from a file without loading them into the process environment. `--engine postgres|mysql|mongo` is needed with `DB_HOST` variables when `DB_PORT` is not the engine default.

```sh
npx loadwise perf db --env-file .env.staging --schema-snapshot snapshot.json
npx loadwise perf db --queries queries.sql --analyze
npx loadwise perf --schema snapshot.json
```

| Flag                                         | Effect                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--schema-snapshot FILE`                     | Write a schema snapshot (indexes, table sizes, measured round trip) for `--schema`.                             |
| `--top N`                                    | Explain the N slowest statements (default 20).                                                                  |
| `--queries FILE`                             | Explain these concrete SELECT statements.                                                                       |
| `--analyze`                                  | Run `EXPLAIN ANALYZE` on the `--queries` SELECTs inside rolled-back read-only transactions.                     |
| `--measure --i-understand-this-locks-tables` | PostgreSQL staging only. Time each suggested index for `--queries` by building it in a rolled-back transaction. |
| `--runs N`                                   | `EXPLAIN ANALYZE` runs per side for `--measure` (default 5).                                                    |

<a id="db-unindexed-foreign-key"></a><a id="db-seq-scan-heavy-table"></a><a id="db-slow-query-plan"></a><a id="db-missing-index"></a><a id="mongo-collection-scan-observed"></a><a id="db-unused-index"></a><a id="db-duplicate-index"></a>Rules: `db-unindexed-foreign-key`, `db-unused-index`, `db-duplicate-index`, `db-seq-scan-heavy-table`, `db-slow-query-plan`, `db-missing-index` and, for MongoDB, `mongo-collection-scan-observed`. `--include-contextual`, `--ignore RULE` and `--json` work as in the other commands.

**Safety guarantees.** Statements go through a read-only gateway: sessions and transactions are read-only, with a 5 s statement timeout on PostgreSQL, and only SELECT, INSERT, UPDATE and DELETE can be explained. `EXPLAIN ANALYZE` runs only for a plain SELECT (a `WITH` that modifies data is refused). MongoDB uses a command allowlist. Error text is redacted: the connection URL, host, user, password and resolved IP addresses are replaced with `[redacted]`. Usage counters come from the node that answered, so an index unused here may still be used on a replica.

**`--measure` warning.** Building an index blocks writes to that table while it runs. Use it on staging only. It refuses a connection variable or database name matching `/prod/i`, a replica, an unknown table size and any table over 5,000,000 estimated rows, and it needs the long confirmation flag. When the HypoPG extension is installed, suggested indexes are also checked hypothetically without building anything.

**Measured vs estimated.** Output labels every figure. A _measured_ number was timed on your database (a round-trip median, or an `EXPLAIN ANALYZE` before and after an index built by `--measure`). An _estimated_ number comes from planner statistics or a model, and a suggestion validated only by HypoPG still says it is an estimate. Treat estimates as a reason to test, not as a result.

## Interpreting findings

Start with the endpoint's query count, latency and a representative input size. A reusable index or lookup table costs memory and build time. An extra database index also costs writes and storage. For a proposed batch or cache, compare results as well as time, including empty inputs, duplicates, tenant boundaries and concurrent writes.

The rules cover query shape, caching candidates, pooling, selected blocking work and collection complexity. Response compression settings, CDN placement, load balancing, partitioning, service boundaries and capacity planning depend on traffic, topology and operational costs. Use workload measurements when making those deployment decisions. [10 Essential Tips for Backend Performance Optimization](https://medium.com/@rhgustmfrh/10-essential-tips-for-backend-performance-optimization-8b55fce0ca17) · [Backend Performance Best Practices roadmap](https://roadmap.sh/backend-performance-best-practices)

## Impact levels

Every finding carries an impact level. `--min-impact <low|medium|high|critical>` reports only findings at that level or above, and the filtered ones do not count toward the exit code; an unknown level exits 2. JSON findings carry it as `impactLevel` (`impact` is the before/after estimate). Text output shows the level after the rule and lists the most severe finding first within each file, keeping the current order for equal levels.

- `critical`: data loss or corruption, an outage or a lock risk in production.
- `high`: a per-request scaling problem such as an N+1 or query in a loop, a deep offset, a missing foreign-key or filter index, an HTTP call without a timeout, or a dependency cycle with load-time effects.
- `medium`: a measurable but local cost, or significant maintainability debt.
- `low`: a micro-optimization or a readability issue.

| Rule                                  | Impact   |
| ------------------------------------- | -------- |
| `api-removed-operation`               | critical |
| `drizzle-unfiltered-write`            | critical |
| `migration-breaking-drop`             | critical |
| `migration-column-type-rewrite`       | critical |
| `migration-index-not-concurrent`      | critical |
| `migration-mysql-table-copy`          | critical |
| `migration-table-rewrite-command`     | critical |
| `pg-transaction-on-pool`              | critical |
| `pg-unreleased-checkout`              | critical |
| `pool-created-per-request-or-item`    | critical |
| `prisma-read-modify-write`            | critical |
| `prisma-transaction-client-escape`    | critical |
| `typeorm-transaction-client-escape`   | critical |
| `api-enum-value-removed`              | high     |
| `api-removed-field`                   | high     |
| `api-required-input`                  | high     |
| `api-type-changed`                    | high     |
| `db-missing-index`                    | high     |
| `db-seq-scan-heavy-table`             | high     |
| `db-slow-query-plan`                  | high     |
| `db-unindexed-foreign-key`            | high     |
| `drizzle-query-in-loop`               | high     |
| `external-call-in-transaction`        | high     |
| `find-then-create-race`               | high     |
| `unbounded-list-query`                | high     |
| `unbounded-module-cache`              | medium   |
| `whole-payload-in-memory`             | medium   |
| `list-query-overfetch`                | medium   |
| `orm-deep-offset`                     | high     |
| `list-count-per-request`              | medium   |
| `notification-send-in-loop`           | high     |
| `session-memory-store`                | high     |
| `orm-cartesian-include`               | high     |
| `retry-without-backoff`               | medium   |
| `json-roundtrip-clone`                | low      |
| `mongoose-aggregate-uncast-id`        | high     |
| `mongoose-hydrate-for-to-object`      | medium   |
| `express-missing-compression`         | low      |
| `heavy-media-in-request-handler`      | medium   |
| `async-route-unhandled-rejection`     | high     |
| `async-callback-unhandled-rejection`  | high     |
| `stream-pipe-unhandled-error`         | high     |
| `json-parse-unguarded`                | medium   |
| `request-number-unvalidated`          | medium   |
| `index-redundant-prefix`              | low      |
| `floating-promise`                    | high     |
| `discarded-error-result`              | high     |
| `promise-return-escapes-catch`        | high     |
| `return-in-finally`                   | high     |
| `return-newline`                      | high     |
| `drizzle-write-preflight`             | medium   |
| `drizzle-last-insert-id`              | medium   |
| `repeated-workbook-decode`            | medium   |
| `http-call-without-timeout`           | high     |
| `index-missing-filter`                | high     |
| `index-missing-foreign-key`           | high     |
| `index-unusable-expression`           | high     |
| `index-unusable-pattern`              | high     |
| `migration-breaking-rename`           | high     |
| `migration-concurrent-in-transaction` | high     |
| `migration-constraint-not-valid`      | high     |
| `migration-constraint-without-index`  | high     |
| `migration-missing-lock-timeout`      | high     |
| `migration-mysql-lock-unspecified`    | high     |
| `migration-not-null-without-default`  | high     |
| `migration-set-not-null-scan`         | high     |
| `migration-volatile-default`          | high     |
| `mongo-collection-scan`               | high     |
| `mongo-collection-scan-observed`      | high     |
| `mongo-deep-skip`                     | high     |
| `node-sync-crypto-in-async`           | high     |
| `node-sync-process-in-async`          | high     |
| `orm-query-in-loop`                   | high     |
| `password-hash-sync-in-async`         | high     |
| `pg-deep-offset`                      | high     |
| `pg-query-in-loop`                    | high     |
| `pg-sequential-scan`                  | high     |
| `prisma-dependent-writes`             | high     |
| `prisma-query-in-loop`                | high     |
| `queue-add-in-loop`                   | high     |
| `rebuild-lookup-in-loop`              | high     |
| `redis-command-in-loop`               | high     |
| `redis-keys-command`                  | high     |
| `redis-keys-scan`                     | high     |
| `repeated-db-span`                    | high     |
| `service-query-in-loop`               | high     |
| `typeorm-load-then-save`              | high     |
| `typeorm-transaction-in-loop`         | high     |
| `upload-without-size-limit`           | high     |
| `array-repeated-find`                 | medium   |
| `array-repeated-membership`           | medium   |
| `await-before-early-exit`             | medium   |
| `csharp-fixed-regex-in-loop`          | medium   |
| `duplicate-key-read`                  | medium   |
| `go-fixed-regexp-in-loop`             | medium   |
| `guard-query-per-request`             | medium   |
| `index-missing-order`                 | medium   |
| `java-fixed-regex-in-loop`            | medium   |
| `known-reads-awaited-serially`        | medium   |
| `loop-copy-accumulator`               | medium   |
| `mongo-disk-sort`                     | medium   |
| `node-sync-compression-in-async`      | medium   |
| `node-sync-fs-in-async`               | medium   |
| `orm-count-materialization`           | medium   |
| `password-hash-pure-js`               | medium   |
| `pg-count-materialization`            | medium   |
| `pg-disk-sort`                        | medium   |
| `pg-filter-materialization`           | medium   |
| `pg-first-materialization`            | medium   |
| `pg-top-k-materialization`            | medium   |
| `prisma-count-materialization`        | medium   |
| `prisma-distinct-in-memory`           | medium   |
| `prisma-filter-materialization`       | medium   |
| `prisma-first-materialization`        | medium   |
| `prisma-relation-count-in-list`       | medium   |
| `prisma-top-k-materialization`        | medium   |
| `promise-combinator-serial-await`     | medium   |
| `python-copy-growing-list`            | medium   |
| `python-sync-requests-in-async`       | high     |
| `python-blocking-sleep-in-async`      | high     |
| `python-fixed-regex-in-loop`          | low      |
| `redis-incr-then-expire`              | medium   |
| `redis-repeated-read`                 | medium   |
| `reduce-copy-accumulator`             | medium   |
| `rust-fixed-regex-in-loop`            | medium   |
| `serial-awaits-in-literal`            | medium   |
| `typeorm-existence-materialization`   | medium   |
| `count-then-page-serial`              | low      |
| `typeorm-unused-count`                | medium   |
| `prisma-count-for-existence`          | medium   |
| `db-duplicate-index`                  | low      |
| `db-unused-index`                     | low      |
| `filter-for-existence`                | low      |
| `migration-unparsed`                  | low      |
| `numeric-sort-for-extreme`            | low      |
| `typeorm-wide-projection`             | low      |

## Verification and benchmarks

Integration checks used PostgreSQL 18.0 and MongoDB 8.2.3. Each engine examined 20,000 records for one match before an index was added. The corresponding indexed read passed. In both databases a deep page walked 15,010 entries to return ten, and the equivalent keyset query passed. Both engines also produced a disk-sort finding. MongoDB's live test used classic execution stages.

On Redis 7.2.16, the CLI flagged a real `KEYS` call and eight redacted `GET` calls. A test hook exposing only a synthetic key let it identify eight duplicate reads. A single request-local read returned the same eight values and passed. Python SQLite instrumentation separately verified nine statements versus one batched statement for the same eight result rows.

Use Node.js 22.13+ for the full development workflow, including the in-memory SQLite benchmark.

### Source conventions

The code is TypeScript (`.cts`) compiled in place to CommonJS (`.cjs`, not committed) by `npm run build`; `npm test` builds first and `npm run typecheck` checks without emitting. Import with the `.cjs` extension (`import { x } from './module.cjs'`). The compiler runs in `strict` mode.

- Write ES `import`/`export`, with imports at the top of the file. `require()` is limited to the files listed under `overrides` in `.oxlintrc.json`, where load order or startup cost forbids a top-level import (the compiler must be chosen before the rules load, and `maint --staged` must not load TypeScript). Lazy loads in an async function use `await import()`. Do not add files to that list.
- No `any` and no `as` assertions (`as const` is fine) in new code. Narrow with type guards, give a function a precise type, or use overloads. A deliberate exception needs a lint-disable comment that says why.
- Types shared by two or more files live in the `types/` folder of their area (`lib/performance/types/`, `lib/security/types/`, `lib/maintainability/types/`, `lib/shared/types/`, `test/types/`), one topic per file. Cross-pillar types are in `lib/shared/types.cts`. A type used by one file stays in that file.
- Comments wrap at 100 columns, and Prettier formats everything. `.vscode/settings.json` formats on save, and the pre-commit hook in `hooks/` formats and lints staged files (`npm install` enables it).

```sh
npm ci
npm test
node bin/loadwise.cjs perf -p examples
npm run bench:patterns
npm run bench:scan
npm run bench:scan -- --large
npm run bench:traces
npm run bench:scorecard
npm run bench:corpus
npm run bench:recall
```

The benchmark commands verify their expected results. The pattern benchmark compares equal application outputs. The scan benchmarks measure the checker itself. Real request latency depends on the workload, instrumentation and database. `bench:scorecard` writes `bench/corpus/scorecard.md`, and `bench:corpus` fails when a default-level rule with at least 10 labels is under 80% precision, unless `bench/corpus/precision-floor-exceptions.json` lists it. `bench:recall` scans the known-vulnerable and known-slow snippets in `bench/recall/cases`, prints the recall, and exits 1 while any case in `bench/recall/manifest.json` is missed.

To repeat the optional six-package ORM declaration integration from the source checkout, run the commands below. The fixture typechecks the application, compares exact diagnostic locations and checks that clean controls stay quiet.

```sh
npm --prefix test/integration/orms install --ignore-scripts --omit=optional --no-audit --no-fund
npm --prefix test/integration/orms run verify -- --native
```

The large benchmark checks 3,200 generated source files and verifies expected diagnostics. The performance report also covers a 1,180-file NestJS checkout. [Measurements and methodology](PERFORMANCE.md)

## References

Prisma documents per-item queries and batching. Node documents the event-loop effects of synchronous file I/O. [Prisma query optimization](https://www.prisma.io/docs/orm/v6/prisma-client/queries/query-optimization-performance) · [Node event loop guidance](https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop)

Repeated lookups can benefit from a reusable membership index. Repeated growing copies can become quadratic. Biome already includes a lint rule for accumulating spread. [JavaScript Set](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set) · [Array.reduce](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/reduce#when_to_not_use_reduce) · [Biome rule](https://biomejs.dev/linter/rules/no-accumulating-spread/javascript/)

Sentry also has an N+1 detector that considers sequential spans and their total duration. This package's local trace check groups similar sibling calls, including concurrent calls. [Sentry N+1 detection](https://docs.sentry.io/product/issues/issue-details/performance-issues/n-one-queries/)

# Maintainability checker

`loadwise maint` finds code that would benefit from a design review and enforces the architectural decisions a team has already made. Run it on a project folder with `npx loadwise maint .`, or `npx loadwise maint . --json` for structured output.

## What gets checked

| Rule                                                                                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="deep-control-flow"></a>`deep-control-flow`                                               | Four nested control structures. JS/TS reports the deepest site in each function. The other parsers report threshold crossings in supported conditional and loop bodies. Independent function scopes start fresh.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| <a id="high-branch-complexity"></a>`high-branch-complexity`                                     | A JS/TS function reaches a score of 15. Start at one and count each conditional, loop, switch, catch or ternary. A flat switch contributes one decision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| <a id="duplicate-implementation"></a>`duplicate-implementation`                                 | Substantial functions share a verified implementation. The report groups matching sites so a reviewer can compare their contracts before introducing a shared abstraction. JS/TS compares syntax while preserving identifiers, literals and operations. Python, Go, Java, C# and Rust compare exact body text of named functions selected by the parser. This deliberately misses reformatted or renamed copies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| <a id="dependency-cycle"></a>`dependency-cycle`                                                 | An eager internal dependency path returns to its starting module. One ordered example path is shown per strongly connected component. Deferred loads can still be checked against folder boundaries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| <a id="folder-boundary"></a><a id="file-placement"></a>`folder-boundary` and `file-placement`   | An import crosses a boundary declared by the team, or a filename suffix occurs outside its allowed folders. Both policies are opt-in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| <a id="data-access-boundary"></a>`data-access-boundary`                                         | A JS/TS file outside the approved paths imports a configured database driver or ORM module at runtime. Static imports, re-exports, `import x = require()`, literal dynamic imports and unshadowed `require()` calls are checked. The policy is opt-in via `dataAccess`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| <a id="query-mutates-state"></a>`query-mutates-state`                                           | A JS/TS class instance method marked `/** @maintainabilityQuery */` writes directly through `this`. Assignments, increments, deletes and destructuring writes are covered. Mutations through aliases or arbitrary helper calls require review.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| <a id="sql-insert-truncated-at-semicolon"></a>`sql-insert-truncated-at-semicolon`               | An INSERT dump parser ends its captured values at the next semicolon, which can occur inside quoted data. Use a parser for the dump dialect and test a quoted semicolon.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| <a id="swallowed-error"></a>`swallowed-error`                                                   | A JS/TS `catch` block in non-test code is empty, or only calls `console.*`, `logger.*` or `this.logger.*` while the code after the `try` carries on as if it had succeeded. A comment inside the block, an optional `require()` or `import()` probe, a cleanup in a `finally` or `catch` block, and a `try` made only of `close`, `destroy`, `release`-style calls are accepted. A catch that rethrows, returns or records a failure is not reported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| <a id="unused-export"></a><a id="unreferenced-file"></a>`unused-export` and `unreferenced-file` | An export no scanned file imports, and a source file nothing imports that is not an entry point. Static, type-only, `require()`, literal dynamic imports, `export … from` and `export *` count as use. An unshadowed `new Worker(new URL('./worker.ts', import.meta.url))` or `SharedWorker` counts as loading the file. A namespace import or `require()` uses the whole module. Deep imports by package name from sibling workspace members count as use of the names they import. When the scanned folder's own config has no `paths`, the aliases of an ancestor `tsconfig.json` or `jsconfig.json` that covers it resolve imports. Entry points are `package.json` `main`, `module`, `bin`, `exports` and script paths (also from a `package.json` above the scanned folder, mapped onto the scanned source), literal Node commands in GitHub Actions job steps, local script references in HTML, `nest-cli.json` entry files, `project.json` commands, `tsconfig` `files`, tests, scripts, configuration, migrations, entities, seeds, route folders (`pages/`, `routes/`, and `app/` in Next or Remix projects) and `main`/`index` files at a package root. A non-literal `import()` or `require()` makes findings contextual, project-wide when the specifier is unknown and for one folder when it starts with a relative path. Skipped in `--staged` and `--changed-since` runs, which do not see the whole project. When adopting loadwise on an existing codebase, record the current findings once with `loadwise check --write-baseline` and check with `--baseline`, so only new unused exports and files are reported. |
| <a id="large-module"></a>`large-module`                                                         | A JS/TS file has more than 600 lines of code, not counting comments and blank lines. Generated and test files are skipped. Override with `limits.largeModuleLines`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| <a id="large-class"></a>`large-class`                                                           | A class has more than 30 methods, accessors, constructors or function-valued fields. Plain data properties (entities, DTOs) are not counted. Override with `limits.largeClassMembers`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| <a id="long-parameter-list"></a>`long-parameter-list`                                           | A function with a body takes more than 5 positional parameters. A destructured object counts as one. Constructors with decorators or parameter properties (dependency injection lists) and parameters with decorators (`@Body()`, `@Param()`) are not counted. Override with `limits.longParameterCount`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

JS and TS source checks use the TypeScript parser. The optional ast-grep executable supplies native parsers for Python, Go, Java, C#, Rust, PHP, Ruby, Kotlin, C and C++. The nesting rule recognizes specific grammar constructs. Braceless forms and pattern-matching constructs have different coverage across languages. A `.h` file uses the C grammar. Use a C++ header extension for C++ grammar.

For any language, filename placement works directly on the inventory and module graphs can be supplied by a compiler, build system or dependency extractor. Direct import extraction is provided for JS/TS. It resolves project-local modules and TypeScript paths and ignores explicitly type-only imports. Unresolved aliases, compiler-specific metadata, runtime-generated imports, and some re-exports can change the actual runtime graph. JSON includes per-language parsed-file counts and the number of files eligible for automatic dependency analysis.

## Project rules

Save team decisions in `maintainability.config.json` at the project root, or pass `--config path/to/policy.json`.

```json
{
  "boundaries": [{ "from": "src/domain", "disallow": ["src/http"] }],
  "placement": [{ "suffix": "_adapter.py", "under": ["adapters", "integrations"] }],
  "dataAccess": { "modules": ["pg", "@prisma/client", "./src/generated"], "allowIn": ["src/data"] },
  "limits": { "largeModuleLines": 600, "largeClassMembers": 30, "longParameterCount": 5 },
  "exclude": ["third_party/legacy"]
}
```

`limits` sets the thresholds of `large-module`, `large-class` and `long-parameter-list`. Each is a positive integer, and the values shown are the defaults.

`dataAccess` restricts runtime imports of named packages, their subpaths, module aliases (`#models`, `@/db`) or project-local entry points (entries starting with `./`) to the project-relative directories or files in `allowIn`. Local entries match the resolved file, so `./store` and `./store/index.ts` are different targets. `import type`, `export type` and, outside `verbatimModuleSyntax` projects, all-inline-`type` specifier lists are erased and not reported. Both `modules` and `allowIn` are required and nonempty. Findings are contract violations and fail the default `--fail-on contract`. Resolution is syntactic per file, with no type checker, so an ambient `declare module` does not count as a local file.

Paths use project-relative directory or file names. Directory boundaries match complete segments. The longest matching filename suffix wins. With no configuration, each project keeps its own folder conventions. Discovery uses tracked and nonignored untracked Git files where available and a directory walk elsewhere. Dependency directories and minified files are skipped. `build`, `dist`, `coverage`, `target` and `vendor` are skipped as build output only at the scanned root or beside a project manifest such as `package.json`; a source folder with one of those names, such as `src/build/`, is scanned. Use explicit exclusions for other checked-in vendor code.

## Inline fixes

Findings with a safe rewrite carry it as `fix = { changes: [{ file, line, before, after }], note? }` in `--json` output, and the text output prints it as a diff.

```sh
npx loadwise maint . --fix         # asks y/n/a/q for each fix; needs a terminal
npx loadwise maint . --fix --yes   # applies every fix without asking
```

`--fix` is refused with `--json` or `--graph`, and `--yes` alone is refused. Without a terminal, `--fix` requires `--yes`. A fix applies only where the original lines still exist. One that an earlier fix made stale is skipped and reappears, rebuilt, on the next run. Review the diff and run your tests afterwards.

| Rule                       | Rewrite                                                                                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deep-control-flow`        | Lifts the deepest branch one level with a guard clause, a merged nested `if`, or by dropping an `else` after a branch that exits.                                                                                                                                                     |
| `high-branch-complexity`   | Combines nested conditional expressions with the same literal success label while preserving short-circuit order. Other fixes merge nested `if`s, join adjacent same-exit `if`s with `\|\|`, turn `x ? true : false` into `Boolean(x)`, and `if (!x) x = value` into `x \|\|= value`. |
| `duplicate-implementation` | Keeps one top-level function and makes each other copy delegate to it, adding an import where needed. Applied only when every name the copies use resolves to the same binding.                                                                                                       |
| `dependency-cycle`         | Turns an import whose names are used only as types into `import type`, which removes that edge from the runtime cycle.                                                                                                                                                                |

Other rules have no automatic rewrite.

## A module graph in any language

```json
{
  "files": ["src/domain/order.ex", "src/http/handler.ex"],
  "edges": [
    { "from": "src/domain/order.ex", "to": "src/http/handler.ex", "line": 3, "column": 1 }
  ]
}
```

```sh
npx loadwise maint . --graph modules.json --config maintainability.config.json
```

List each project-relative module once. Edges use one-based source coordinates. Set `"kind": "deferred"` for an edge that loads lazily. Graph mode operates entirely on the supplied inventory and edges.

## CI and design review

Source checks count lower-priority findings separately. Use `--include-contextual` to display them with a reason. The JSON field `contextualFindingCount` is the additional count in the default view and a subset of `findings` in the expanded view. `--fail-on all` applies to displayed findings. Explicit folder and query contracts always remain visible.

Context includes documented independent test oracles, before/after source snapshots with a corresponding live file, marked generated code, certain flat data mappings, and flat lists of optional literal messages selected by simple field checks. Two ordinary implementations still form a default duplicate finding even when an archive or test oracle also contains a copy. A Nest module cycle can receive context when every internal eager edge is used solely in an explicit module `forwardRef` callback. A cycle supplied through graph input has no such source evidence.

The default `--fail-on contract` exits 1 for a declared folder, data-access or query contract violation. Design advisories remain visible and exit 0 on their own. Use `--fail-on all` to fail on any finding. Invalid configurations, a non-JavaScript file a native parser cannot read and missing required parser binaries exit 2. A JavaScript or TypeScript file that does not parse is skipped, named in a stderr note and in `skippedFiles` in `--json` output, and the run exits 2.

DRY candidates can represent intentional copies between isolated modules. Deep nesting can accurately reflect a protocol. Use the reported locations to decide whether extracting a function, changing a dependency or retaining the current implementation makes the next change easier. YAGNI, Tell Don't Ask, the Law of Demeter and CUPID depend on domain knowledge. Fluent call chains and unused extension points alone do not establish a violation. [CUPID and the properties of good code](https://dannorth.net/cupid-for-joyful-coding/)

## Apply fixes by id

Every finding in `--json` output has a stable `id` (also shown as `#id` in text output), `fixable`, and `fix` when a rewrite exists. The id hashes the rule, the file and the flagged line's text, so it survives edits above the finding.

```sh
npx loadwise maint . --fix --only <id>[,<id>...] [--json]
```

`--only` applies exactly those fixes with no prompt and no terminal. `--json` prints `{ applied, alreadyApplied, failed }`. An id whose change an earlier id in the same run already made is reported in `alreadyApplied`; an unknown id, a finding without a fix or a stale fix is in `failed` and the exit code is 2.

To dismiss a false positive, put `// loadwise-reviewed <rule-id> -- <specific reason>` on the line above it (line 1 itself for a finding about a whole file, such as `large-module`). The finding becomes contextual with that reason. Only a real line comment counts, and declared contracts (`file-placement`, `folder-boundary`, `data-access-boundary`, `query-mutates-state`) cannot be dismissed this way.

## Changed lines

```sh
npx loadwise maint --staged .
npx loadwise maint --changed-since <git-ref> .
```

`--staged` reports only findings on lines added or changed in `git diff --cached`; `--changed-since <git-ref>` does the same for the working tree against that ref. A JS/TS function-level finding (`high-branch-complexity`, `deep-control-flow`) is kept when a changed line falls anywhere inside its function. In other supported languages, deep nesting is reported when its flagged line changes. Text output is one block per finding (`path:line [rule-id #id] message`, then a `fix:` command when a rewrite exists and a `dismiss:` comment for a reviewable JS/TS finding), ending with `N new finding(s) in changed lines.`. `--json` works too, with the same shape filtered. Changed files in any supported source language are checked. With `--changed-since`, untracked source files count as entirely new. When no supported source changed, text output is empty and the checker exits 0 before loading TypeScript. In these modes `--fail-on` defaults to `all`, so the exit code is 1 whenever a finding remains.

Only the changed files are analysed, while imports still resolve through the whole project. When as many files changed as the full scan's parallel threshold (600), the full scan runs instead and its findings are filtered to the changed lines, so every rule applies. Otherwise rules that need every file are limited: `duplicate-implementation` is skipped and `dependency-cycle` only sees cycles made of changed files' imports. Boundary and placement rules still run. Analysis reads working-tree files, so a file with unstaged edits can report shifted lines.

## Impact levels

The levels and the `--min-impact` flag work as described under the performance checker's impact levels.

| Rule                                | Impact |
| ----------------------------------- | ------ |
| `dependency-cycle`                  | high   |
| `data-access-boundary`              | medium |
| `duplicate-implementation`          | medium |
| `folder-boundary`                   | medium |
| `high-branch-complexity`            | medium |
| `query-mutates-state`               | medium |
| `sql-insert-truncated-at-semicolon` | high   |
| `swallowed-error`                   | medium |
| `syntax-error`                      | medium |
| `deep-control-flow`                 | low    |
| `file-placement`                    | low    |
| `large-class`                       | low    |
| `large-module`                      | low    |
| `long-parameter-list`               | low    |
| `unreferenced-file`                 | low    |
| `unused-export`                     | low    |

# Security checker

`loadwise sec` reports code paths where input or missing scope can expose data: runtime text composed into SQL and, when the project declares them, Prisma and Drizzle queries that do not prove their row scope. Findings are review prompts with a location, a rule ID, an impact level, a generic fix example and, where it is safe, a source-based fix.

## Run it

```sh
npx loadwise sec                      # tsconfig.json or jsconfig.json in the current folder
npx loadwise sec -p tsconfig.json --json
npx loadwise sec src/orders.ts        # explicit files
npx loadwise sec --staged             # only findings on staged lines
npx loadwise sec deps --online        # known-vulnerable packages in the lockfile
```

It accepts the source-check flags of `loadwise perf`, including `--format`, `--min-impact`, `--baseline`, `--write-baseline`, `--loadwise-config`, `--workspace`, `--policy`, `--json`, `--include-contextual`, `--ignore`, `--fail-on`, `--fix` with `--yes` or `--only` and `--no-comments` or `--no-format`, `--staged` and `--changed-since`. It uses the TypeScript 6 compiler: `--engine auto` (the default) and `--engine js` both run the JS engine, because the native engine finds less. `--engine native` (alias `--native`) runs the TypeScript 7 native compiler and prints a stderr note that cross-file taint through JavaScript constructor functions and rate-limit detection are reduced. Rules that need a package's types stay silent until the package is installed; rules that recognise a library by its import work without `node_modules`. Test, fixture, mock, example and story files are contextual: they are counted, and `--include-contextual` shows them with the reason `Test or example source.`. `--fail-on contract` enforces no security rule by default. `--fix --yes` leaves changes to ValidationPipe whitelisting for individual review because enabling it can strip undecorated DTO properties.

## Rules

| Rule                                                                              | What to review                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="pg-dynamic-query-text"></a>`pg-dynamic-query-text`                         | Runtime fragments enter SQL text directly. Bind data as parameters and verify how any dynamic identifiers are chosen and quoted. A finding is a code-review prompt.                                                                                                                                                                                                          |
| <a id="prisma-scope-unverified"></a>`prisma-scope-unverified`                     | A Prisma read or write on a model listed in `prismaScopes` does not prove the configured scope in its filter, projection or write data.                                                                                                                                                                                                                                      |
| <a id="drizzle-scope-unverified"></a>`drizzle-scope-unverified`                   | A Drizzle query on a table listed in `drizzleScopes` does not prove the configured predicate, projection or write data.                                                                                                                                                                                                                                                      |
| <a id="code-injection"></a>`code-injection`                                       | Request data is evaluated as code: `eval`, `new Function`, `vm`, a string timer callback, `require`/`import()` of a request path, or node-serialize.                                                                                                                                                                                                                         |
| <a id="command-injection"></a>`command-injection`                                 | Request data reaches a command line a shell parses: `exec`, or `spawn`/`execFile`/execa with `shell` or `sh -c`. An interpolated parameter with no traced caller is contextual.                                                                                                                                                                                              |
| <a id="drizzle-sql-raw-dynamic"></a>`drizzle-sql-raw-dynamic`                     | `sql.raw` from drizzle-orm receives text built from a runtime value.                                                                                                                                                                                                                                                                                                         |
| <a id="knex-raw-dynamic-text"></a>`knex-raw-dynamic-text`                         | A Knex `*Raw` fragment or `knex.raw` receives text built from a runtime value instead of `?`/`??` bindings.                                                                                                                                                                                                                                                                  |
| <a id="mysql-dynamic-query-text"></a>`mysql-dynamic-query-text`                   | A `mysql`/`mysql2` `query` or `execute` receives SQL text built from a runtime value instead of `?` placeholders.                                                                                                                                                                                                                                                            |
| <a id="nosql-operator-injection"></a>`nosql-operator-injection`                   | Request data that can arrive as an object is a Mongoose or MongoDB filter, a filter value or a `$where` expression. Contextual when applicable Express sanitizer registration is visible. Fix: wrap the value in `$eq`.                                                                                                                                                      |
| <a id="prisma-raw-unsafe-dynamic"></a>`prisma-raw-unsafe-dynamic`                 | `$queryRawUnsafe`, `$executeRawUnsafe` or `Prisma.raw` receives SQL text built from a runtime value.                                                                                                                                                                                                                                                                         |
| <a id="regex-from-input"></a>`regex-from-input`                                   | Request text becomes a regular expression through `RegExp`, `match`/`matchAll`/`search` on a string, or a `$regex` operand, without escaping.                                                                                                                                                                                                                                |
| <a id="regex-catastrophic-backtracking"></a>`regex-catastrophic-backtracking`     | A fixed regular expression with nested or overlapping repetition (such as `(a+)+` or `(a\|aa)+`), or overlapping repeats in sequence (such as `\s+.*\s+$`), runs on request input and can backtrack exponentially or in polynomial time, blocking the event loop. Rewrite it so each part matches text one way, or cut the input to a fixed length first.                    |
| <a id="sequelize-dynamic-query-text"></a>`sequelize-dynamic-query-text`           | `sequelize.query` or `literal` receives SQL text built from a runtime value instead of `replacements` or `bind`.                                                                                                                                                                                                                                                             |
| <a id="template-injection"></a>`template-injection`                               | Request data is the template text of `ejs`, `pug`, `handlebars`, `nunjucks`, `mustache` or lodash `template`.                                                                                                                                                                                                                                                                |
| <a id="typeorm-dynamic-query-text"></a>`typeorm-dynamic-query-text`               | A TypeORM `query` or a query-builder condition, order, group, select or join receives SQL text built from a runtime value.                                                                                                                                                                                                                                                   |
| <a id="open-redirect"></a>`open-redirect`                                         | A redirect target whose site comes from request data. A fixed origin or an enforced relative-path check can keep the target on site. A Referer target is contextual.                                                                                                                                                                                                         |
| <a id="path-traversal"></a>`path-traversal`                                       | A file path built from request data reaches `fs`, `res.sendFile` without `root`, `res.download` or `res.render`. `path.basename` and a containment check clear it. An anchored filename allowlist also clears it when the checker can prove the allowed characters and the validated value reaches the file operation unchanged.                                             |
| <a id="ssrf-request-url"></a>`ssrf-request-url`                                   | An outgoing HTTP request whose URL or host comes from request data. A fixed origin with a request path, an enforced exact host allowlist on the parsed URL, or an SSRF-filtering agent is quiet.                                                                                                                                                                             |
| <a id="upload-client-filename"></a>`upload-client-filename`                       | multer disk storage saves uploads under the client's file name, so same-named uploads overwrite each other and the client picks the extension.                                                                                                                                                                                                                               |
| <a id="zip-slip-extraction"></a>`zip-slip-extraction`                             | An archive entry name (adm-zip, yauzl, unzipper, tar-stream, jszip, node-stream-zip) reaches a file write without a prior containment check. The trace follows aliases, destructuring and local call hops.                                                                                                                                                                   |
| <a id="bcrypt-low-cost"></a>`bcrypt-low-cost`                                     | A literal bcrypt cost below 10 passed to `hash`, `hashSync`, `genSalt` or `genSaltSync`. Use 10 or higher and measure the hashing time; the fix writes 12.                                                                                                                                                                                                                   |
| <a id="hardcoded-secret"></a>`hardcoded-secret`                                   | A known credential shape (`sk_live_`, `AKIA...`, `ghp_`, private keys), a string literal used as a JWT, HMAC or session signing key, or a high-entropy value assigned to a secret-named variable or property. Placeholders, documentation examples and test sources are skipped; low-entropy named values are contextual.                                                    |
| <a id="insecure-cipher"></a>`insecure-cipher`                                     | `createCipher` or `createDecipher` (no IV), DES, RC2, RC4 or Blowfish algorithms, ECB mode, or a fixed string or `Buffer.alloc` IV in `createCipheriv`.                                                                                                                                                                                                                      |
| <a id="insecure-random-for-secret"></a>`insecure-random-for-secret`               | `Math.random()` feeds a token, code, nonce, session or secret. Use `crypto.randomBytes`, `randomInt` or `randomUUID`; names that only end in `id` are contextual. `Math.floor(Math.random() * N)` has a source fix.                                                                                                                                                          |
| <a id="jwt-decode-for-auth"></a>`jwt-decode-for-auth`                             | `decode` (`jsonwebtoken`, `JwtService`, the jwt-decode package) has no `verify` on the same token and its result becomes `req.user`, is used in a guard or auth middleware, or filters a query. Other uses are contextual.                                                                                                                                                   |
| <a id="jwt-none-algorithm"></a>`jwt-none-algorithm`                               | The `none` algorithm appears in an `algorithms` list or a `sign` call, so unsigned tokens are accepted or produced.                                                                                                                                                                                                                                                          |
| <a id="jwt-sign-without-expiry"></a>`jwt-sign-without-expiry`                     | `jsonwebtoken` `sign` with a literal payload and no `expiresIn` option or `exp` claim. Literal NestJS JwtService signing also uses expiry set by its bound JwtModule registration. Unresolved defaults are contextual.                                                                                                                                                       |
| <a id="jwt-verify-without-algorithms"></a>`jwt-verify-without-algorithms`         | `jsonwebtoken` `verify` without `algorithms` in a literal options object. Public keys, key files and key-lookup callbacks are default; shared secrets are contextual. The fix pins the algorithm the same key signs with in the file.                                                                                                                                        |
| <a id="secret-compared-non-constant-time"></a>`secret-compared-non-constant-time` | An HMAC or hash digest, or a value named like a signature, secret, token, OTP, password or CSRF token, is compared directly with request input. For strict comparisons of two proven strings in a Node module, the fix uses `crypto.timingSafeEqual` and preserves JavaScript string equality.                                                                               |
| <a id="tls-verification-disabled"></a>`tls-verification-disabled`                 | A literal `rejectUnauthorized: false`, `strictSSL: false` or `NODE_TLS_REJECT_UNAUTHORIZED = '0'`. Under a non-production guard it is contextual; database `ssl` options count too.                                                                                                                                                                                          |
| <a id="weak-password-hash"></a>`weak-password-hash`                               | `createHash` with md5, sha1, sha256 or sha512 (or the crypto-js or md5 package) hashes a password or the digest is stored as one. Use `argon2`, `bcrypt` or `crypto.scrypt`.                                                                                                                                                                                                 |
| <a id="plaintext-password-storage"></a>`plaintext-password-storage`               | A request password is written by an ORM create, update or save, or a raw INSERT or UPDATE, without being hashed. A value named like a hash or digest, and a model hook that hashes on save, keep it quiet. Hash it with `argon2`, `bcrypt` or `crypto.scrypt` first.                                                                                                         |
| <a id="auth-route-without-rate-limit"></a>`auth-route-without-rate-limit`         | A login, signup, password-reset or OTP route has no rate limiter, which allows brute force and credential stuffing. A route is contextual when a limiter package is imported in a module connected to its file by imports (the file itself, one it imports, or app setup that imports it) but not tied to the route; dismiss a gateway or proxy limit with a review comment. |
| <a id="cookie-missing-security-flags"></a>`cookie-missing-security-flags`         | A session, token or auth cookie is set without `httpOnly`, or with `secure: false`. A missing `secure` or `sameSite` is contextual. Non-literal options are not judged.                                                                                                                                                                                                      |
| <a id="cors-credentials-any-origin"></a>`cors-credentials-any-origin`             | CORS options allow credentials with origin `*`, `true`, a match-everything regex or a callback that always accepts. Listed or configured origins are clean.                                                                                                                                                                                                                  |
| <a id="cors-origin-regex-unanchored"></a>`cors-origin-regex-unanchored`           | CORS `origin` regexes, and regex `.test` calls on the request origin, whose host can be prefixed (no `^`, `//` or `\.` before it), extended (no `$` after it) or has an unescaped dot. URL values passed to `new RegExp` count too. Without credentials it is contextual. The fix anchors and escapes a single-branch literal and needs review.                              |
| <a id="error-stack-in-response"></a>`error-stack-in-response`                     | An error `.stack` is written into a response body. A whole error object is contextual. Code that runs only outside production is clean.                                                                                                                                                                                                                                      |
| <a id="graphql-introspection-enabled"></a>`graphql-introspection-enabled`         | A GraphQL server config turns on `introspection`, `playground` or `graphiql` with a literal `true`. Expressions are not judged.                                                                                                                                                                                                                                              |
| <a id="mass-assignment"></a>`mass-assignment`                                     | The whole request body reaches a Prisma, TypeORM, Mongoose or Sequelize write. Decorated DTO classes, schema parses and explicit field picks are clean.                                                                                                                                                                                                                      |
| <a id="nest-validation-without-whitelist"></a>`nest-validation-without-whitelist` | A NestJS `ValidationPipe` is created without `whitelist: true`, so undeclared properties reach handlers. Without `forbidNonWhitelisted` it is contextual.                                                                                                                                                                                                                    |
| <a id="prototype-pollution"></a>`prototype-pollution`                             | A request-controlled key is written through a nested path, or the whole request goes to lodash `merge`, `defaultsDeep`, a path `set` or an unguarded local deep merge.                                                                                                                                                                                                       |
| <a id="reflected-xss-response"></a>`reflected-xss-response`                       | Request data is interpolated into an HTML string sent with `res.send`. Contextual only in this version.                                                                                                                                                                                                                                                                      |
| <a id="secret-in-log"></a>`secret-in-log`                                         | A password, token, key or authorization value is passed to a logger call. Logging a whole request body or headers object is contextual.                                                                                                                                                                                                                                      |
| <a id="template-autoescape-disabled"></a>`template-autoescape-disabled`           | `swig.setDefaults`, `nunjucks.configure` or `new nunjucks.Environment` sets `autoescape: false`, or Handlebars `compile`/`precompile` sets `noEscape: true`.                                                                                                                                                                                                                 |
| <a id="xml-external-entities"></a>`xml-external-entities`                         | `libxmljs` is asked to load entities or the DTD with `noent: true` or `dtdload: true`.                                                                                                                                                                                                                                                                                       |
| <a id="password-hash-in-response"></a>`password-hash-in-response`                 | A request handler sends a user record read without a field selection, so its password hash reaches the client. Select or omit the field, or hide it on the model (`select: false`, `@Exclude()`).                                                                                                                                                                            |
| <a id="storage-object-public-acl"></a>`storage-object-public-acl`                 | An S3 or Google Cloud Storage upload sets a public-read ACL, so anyone can read the object. Keep objects private and hand out short-lived presigned URLs. Keys or buckets named like public assets are contextual; a public read-write ACL never is.                                                                                                                         |
| <a id="secret-in-url-query"></a>`secret-in-url-query`                             | A password, token or API key is read from, or sent in, a URL query string, where it ends up in access logs, browser history and Referer headers. Send it in a header or the body. Reset, verify and invite tokens, and map or weather APIs that require a query key, are contextual.                                                                                         |
| <a id="graphql-query-depth-unbounded"></a>`graphql-query-depth-unbounded`         | An Apollo, Yoga, graphql-http, mercurius or Nest GraphQL server has no query depth or cost limit, so one deeply nested query can exhaust it. Contextual when the options are not visible or a limit library is imported elsewhere.                                                                                                                                           |
| <a id="database-error-in-response"></a>`database-error-in-response`               | A 5xx response sends a raw database error, or its message, caught from a database call. Driver messages reveal table, column and constraint names; log the error and return a generic message. Express error middleware is contextual.                                                                                                                                       |
| <a id="dom-xss-sink"></a>`dom-xss-sink`                                           | Untrusted or dynamic HTML is written to innerHTML, outerHTML, insertAdjacentHTML, document.write or createContextualFragment, which allows DOM-based XSS.                                                                                                                                                                                                                    |
| <a id="react-dangerously-set-inner-html"></a>`react-dangerously-set-inner-html`   | dangerouslySetInnerHTML receives HTML that is not a constant or sanitized.                                                                                                                                                                                                                                                                                                   |
| <a id="angular-bypass-security-trust"></a>`angular-bypass-security-trust`         | DomSanitizer.bypassSecurityTrust* is called on a dynamic value, which turns off Angular's built-in sanitization.                                                                                                                                                                                                                                                             |
| <a id="vue-v-html-unsanitized"></a>`vue-v-html-unsanitized`                       | A Vue render function binds unsanitized dynamic HTML to innerHTML.                                                                                                                                                                                                                                                                                                           |
| <a id="frontend-storage-secret-token"></a>`frontend-storage-secret-token`         | A token, JWT, password or API key is stored in localStorage or sessionStorage, readable by any script on the page.                                                                                                                                                                                                                                                           |
| <a id="postmessage-missing-origin-check"></a>`postmessage-missing-origin-check`   | postMessage targets '*', or a window message listener reads event.data without checking origin or source.                                                                                                                                                                                                                                                                    |
| <a id="express-missing-helmet"></a>`express-missing-helmet`                       | The Express or NestJS server starts without helmet security headers middleware (contextual: a proxy may set them).                                                                                                                                                                                                                                                           |
| <a id="committed-secret"></a>`committed-secret`                                   | A tracked file holds a credential: a non-placeholder value for a secret-looking key in a tracked `.env` file, or a high-confidence token format (AWS, GitHub, Slack, Stripe live, Google API key, private key block) in any tracked text file. Ignored `.env` files are never read, and the message shows only the key and a four-character prefix.                          |
| <a id="compose-hardcoded-secret"></a>`compose-hardcoded-secret`                   | A docker-compose `environment:` entry sets a secret-looking key to a literal value instead of a substitution or secret.                                                                                                                                                                                                                                                      |
| <a id="dockerfile-add-remote-url"></a>`dockerfile-add-remote-url`                 | `ADD` fetches an `http(s)` URL without a checksum. Download with curl and verify a checksum, or `COPY` a local file.                                                                                                                                                                                                                                                         |
| <a id="dockerfile-runs-as-root"></a>`dockerfile-runs-as-root`                     | The final stage has no `USER` instruction, or its last `USER` is root. Builder stages are not checked.                                                                                                                                                                                                                                                                       |
| <a id="dockerfile-secret-in-build"></a>`dockerfile-secret-in-build`               | An `ARG` or `ENV` with a secret-looking name has a literal default, or `COPY`/`ADD` puts an env file or private key into the image.                                                                                                                                                                                                                                          |
| <a id="dockerfile-unpinned-base-image"></a>`dockerfile-unpinned-base-image`       | A `FROM` image has no tag or uses `:latest`. A version tag is fine; a digest is best.                                                                                                                                                                                                                                                                                        |

The SQL rules report text assembled from a runtime value. When a part of that text traces to request data the finding is default and names the source; when no part does, it is contextual, because the value is usually an internal schema or table name. Every injection rule other than the SQL rules reports only values traced to request data.

The first six rules read project files rather than TypeScript: `loadwise sec -p <tsconfig>` scans the project folder (not explicit source files) with `git ls-files`, so ignored files are skipped; outside a git repository it walks the folder and never opens `.env*` files. `.env.example`, `.env.sample` and `.env.template` are checked for token formats only. Placeholder values (`changeme`, `example`, `your-...`, `${...}`, test or dummy values) and default credentials for a local service are not reported or are contextual. Dockerfile checks follow multi-stage builds: only the final stage matters for `dockerfile-runs-as-root`.

These rules moved from the performance checker with the same ids, so existing `// loadwise-reviewed` comments and `--ignore` flags keep working; `loadwise perf --ignore` still accepts them.

Example: `pool.query('SELECT * FROM orders ORDER BY ' + req.query.sort)` reports `pg-dynamic-query-text`; `pool.query('SELECT * FROM orders WHERE id = $1', [id])` does not.

## Dependency checks

`loadwise sec deps --online [directory]` reads `package-lock.json` (lockfile version 2 or 3), `pnpm-lock.yaml` or `yarn.lock` (version 1 or Berry) from the directory or the nearest parent that has one, and asks the [OSV database](https://osv.dev) (which includes the GitHub Advisory Database) about every pinned package version. It sends package names and versions and nothing else. Answers are cached for 24 hours in the `loadwise` folder of the OS cache directory. It takes `--format text|json` (or `--json`), `--include-contextual`, `--ignore` and `--fail-on`. A network failure exits 2 rather than passing.

The network is opt-in: `loadwise sec --online` and `loadwise check --online` add these findings to their security report, and without `--online` they print one note that dependency checks were skipped.

| Rule                                                                        | What to review                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="dependency-known-vulnerability"></a>`dependency-known-vulnerability` | A locked package version has published advisories. One finding per package and version lists the advisory ids, the highest severity, the fixed version and the fix: `npm install pkg@fixed` for a direct dependency, or an overrides or resolutions entry for a transitive one. Development-only dependencies are contextual. |

## Security impact levels

`--min-impact` sets the minimum level to report. Dependency findings use the advisory severity.

| Rule                                | Impact                                      |
| ----------------------------------- | ------------------------------------------- |
| `pg-dynamic-query-text`             | medium                                      |
| `prisma-scope-unverified`           | high                                        |
| `drizzle-scope-unverified`          | high                                        |
| `code-injection`                    | critical                                    |
| `command-injection`                 | critical                                    |
| `drizzle-sql-raw-dynamic`           | critical                                    |
| `knex-raw-dynamic-text`             | critical                                    |
| `mysql-dynamic-query-text`          | critical                                    |
| `nosql-operator-injection`          | high                                        |
| `prisma-raw-unsafe-dynamic`         | critical                                    |
| `regex-from-input`                  | medium                                      |
| `regex-catastrophic-backtracking`   | high                                        |
| `sequelize-dynamic-query-text`      | critical                                    |
| `template-injection`                | critical                                    |
| `typeorm-dynamic-query-text`        | critical                                    |
| `open-redirect`                     | medium                                      |
| `path-traversal`                    | high                                        |
| `ssrf-request-url`                  | high                                        |
| `upload-client-filename`            | medium                                      |
| `zip-slip-extraction`               | high                                        |
| `bcrypt-low-cost`                   | medium                                      |
| `hardcoded-secret`                  | critical                                    |
| `insecure-cipher`                   | medium                                      |
| `insecure-random-for-secret`        | high                                        |
| `jwt-decode-for-auth`               | high                                        |
| `jwt-none-algorithm`                | critical                                    |
| `jwt-sign-without-expiry`           | medium                                      |
| `jwt-verify-without-algorithms`     | high                                        |
| `secret-compared-non-constant-time` | medium                                      |
| `tls-verification-disabled`         | high                                        |
| `weak-password-hash`                | high                                        |
| `plaintext-password-storage`        | critical                                    |
| `cookie-missing-security-flags`     | high                                        |
| `cors-credentials-any-origin`       | high                                        |
| `cors-origin-regex-unanchored`      | medium                                      |
| `error-stack-in-response`           | medium                                      |
| `graphql-introspection-enabled`     | medium                                      |
| `mass-assignment`                   | high                                        |
| `nest-validation-without-whitelist` | medium                                      |
| `prototype-pollution`               | high                                        |
| `reflected-xss-response`            | low                                         |
| `secret-in-log`                     | high                                        |
| `template-autoescape-disabled`      | medium                                      |
| `xml-external-entities`             | medium                                      |
| `password-hash-in-response`         | high                                        |
| `storage-object-public-acl`         | high                                        |
| `secret-in-url-query`               | medium                                      |
| `auth-route-without-rate-limit`     | medium                                      |
| `graphql-query-depth-unbounded`     | medium                                      |
| `database-error-in-response`        | medium                                      |
| `dom-xss-sink`                      | high                                        |
| `react-dangerously-set-inner-html`  | high                                        |
| `angular-bypass-security-trust`     | high                                        |
| `vue-v-html-unsanitized`            | high                                        |
| `frontend-storage-secret-token`     | medium                                      |
| `postmessage-missing-origin-check`  | medium                                      |
| `express-missing-helmet`            | low                                         |
| `dependency-known-vulnerability`    | Advisory severity (medium when unavailable) |
| `committed-secret`                  | critical                                    |
| `compose-hardcoded-secret`          | high                                        |
| `dockerfile-add-remote-url`         | medium                                      |
| `dockerfile-runs-as-root`           | medium                                      |
| `dockerfile-secret-in-build`        | high                                        |
| `dockerfile-unpinned-base-image`    | low                                         |

## Project-defined row scopes

Row-scope checks read `prismaScopes` and `drizzleScopes` from `backend-perf.policy.json`, found the same way as for the performance checker (see [Project-defined access policy](#project-defined-access-policy)). Every other rule runs without a scope policy. Row-scope checks start when the project identifies the existing model or table, its scoped property, and the helper that supplies an authorized scalar. Columns such as `tenantId`, `organizationId` and `workspace_id` have no special meaning to the checker on their own. Database mappings can keep the original storage column name. [Prisma database mapping](https://www.prisma.io/docs/orm/prisma-schema/data-model/database-mapping) · [Drizzle schema declarations](https://orm.drizzle.team/docs/sql-schema-declaration)

Drizzle also supports configuring quoted properties such as `"org-id"` and accessing them with brackets. In Prisma's generated filters, `AND`, `OR` and `NOT` are logical operators. If a physical column uses one of these names, configure the Prisma property that maps to it.

`prismaScopes` maps each generated model to its own protected field and a named export from the project's trusted authorization module. With the supplied example, `db.invoice.findMany({ where: { organizationId: requireOrganization() } })` has the expected scope. Choose the names already used by the project. The scanner handles common reads, writes and upsert branches, and requires every alternative in an OR to preserve the scope. For dynamic or nested shapes it cannot establish, it emits `prisma-scope-unverified`. Proof requires strict null checks. With explicit source files and a policy, the CLI enables strict null checks for its analysis.

`drizzleScopes` names an exported table, its schema module, its scoped property and the trusted helper. For a direct executed query, `.where(eq(invoices.workspace_id, currentWorkspace()))` establishes the configured predicate in the example. Use the property exposed by the ORM. A project with `organizationId: text('org_id')` would configure `"field": "organizationId"`. Each table can use a different convention. A later `.where()` can replace the earlier condition. The rule checks the effective condition and can report `drizzle-scope-unverified` when a protected table appears in a recognized chain and scope, projection or write data needs review. Stored builders, prepared aliases, raw SQL and arbitrary helper-generated statements can fall outside this check.

The import boundary for database modules is a maintainability rule; configure it through the `dataAccess` section of `maintainability.config.json`.

These checks assume the configured helper authenticates the caller and authorizes the returned scope. Middleware, injected or previously obtained clients, raw SQL, unrecognized query shapes and database row-level policies require separate verification. A clean run only describes the covered operations.

## Developing locally

Use Node.js 22.12+ for the development tools and run `npm ci --include=optional`. Open this repository folder as a trusted workspace in VS Code or Cursor and enable the recommended Prettier extension. Saving a supported file formats it with the repository settings.

Run `npm run format` to format files, `npm run lint` for correctness checks, or `npm run check` to verify formatting, lint and tests together.

From this checkout, run `node bin/loadwise.cjs check` to scan Loadwise itself. The root `jsconfig.json` selects implementation files for performance and security checks so the deliberately slow examples and benchmark workloads keep their intended behavior.

## License

Copyright © 2026 Ibrahim Hafez. All rights reserved. See LICENSE.
