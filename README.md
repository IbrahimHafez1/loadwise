# Loadwise

[![npm](https://img.shields.io/npm/v/loadwise)](https://www.npmjs.com/package/loadwise) [![check](https://github.com/IbrahimHafez1/loadwise/actions/workflows/check.yml/badge.svg)](https://github.com/IbrahimHafez1/loadwise/actions/workflows/check.yml) [![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/IbrahimHafez1/loadwise/badge)](https://scorecard.dev/viewer/?uri=github.com/IbrahimHafez1/loadwise) [![license](https://img.shields.io/npm/l/loadwise?cacheSeconds=3600)](LICENSE)

Loadwise checks a backend project before it ships. One CLI runs five checkers:

- **Performance** (`loadwise perf`): repeated database work, ORM and query integrity, blocking calls, collection complexity, schema-aware indexes, OpenTelemetry traces, executed query plans and an optional read-only database inspection.
- **Reliability** (`loadwise rel`): unhandled rejections and swallowed errors, races and transaction-client escapes, missing timeouts and idempotency keys, migration safety and breaking API changes.
- **Maintainability** (`loadwise maint`): deep nesting, branch complexity, duplicate implementations, dependency cycles and the folder, placement and data-access rules a team declares.
- **Security** (`loadwise sec`): request data reaching sensitive operations, authentication and cryptography, exposed credentials, Docker and Compose configuration, declared row scopes, and optionally dependency advisories.
- **Accessibility** (`loadwise a11y`): images without alt text, unlabelled form controls, click handlers on non-interactive elements, invalid ARIA and missing page language in JSX, HTML, Vue, Svelte and Angular templates. Skipped on projects without frontend sources.

Each finding has a stable `#id` for review. Where a checker can generate an edit, it shows the diff and any assumptions to verify. Supported source rules accept a `loadwise-reviewed` comment with a reason for intentional code.

> **Pre-1.0.** Loadwise is under active development. Until 1.0, rule ids, CLI flags, the JSON report and the config schema can change in a minor release. Every such change is listed in the [changelog](CHANGELOG.md), and a moved or renamed rule keeps accepting its old id where possible. False-positive reports are the most useful feedback: [open one](https://github.com/IbrahimHafez1/loadwise/issues/new?template=false-positive.yml).

## Install

Use Node.js 22 or later. Run directly with `npx` or install as a devDependency:

```sh
npx loadwise check

# or install in your project:
npm install --save-dev loadwise
npx loadwise --version
```

By default `loadwise check` reports actionable findings across Performance, Reliability, Maintainability, Security, and Accessibility; see the [corpus rule scorecard](bench/corpus/scorecard.md) for measured precision and recall across real-world open-source backends.

**Autofix example:** `npx loadwise fix --yes` rewrites eligible issues in place and verifies TypeScript projects with a post-edit typecheck:

```diff
- const names = visible.map((order) => customers.find((c) => c.id === order.customerId)?.name ?? 'Unknown');
+ const customersById = new Map(customers.map((c) => [c.id, c] as const).reverse());
+ const names = visible.map((order) => customersById.get(order.customerId)?.name ?? 'Unknown');
```

**With an AI coding agent**, say **“Run Loadwise”** in your project chat. The agent can run the installed CLI directly. It should check the findings against the code, explain what it would fix or leave alone and why, and let you choose before making edits. [Active-agent workflow and optional MCP setup](#using-loadwise-with-an-active-coding-agent)

**Working manually**, run `npx loadwise check` to see recommendations or `npx loadwise fix --yes` to apply eligible fixes. In any editor with a language server client, `loadwise lsp` shows findings as diagnostics with hovers and fixes. [Editor setup](#editor-language-server)

### Try a finding and a fix

From the directory where you installed Loadwise, copy the bundled example to a disposable file and scan it. The copy command refuses to overwrite an existing file.

```sh
node -e "require('node:fs').copyFileSync('node_modules/loadwise/examples/slow.ts', 'loadwise-demo.ts', require('node:fs').constants.COPYFILE_EXCL)"
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

| Command                                                              | What it does                                                                                                                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadwise` or `loadwise check [directory]`                           | Runs every checker on the directory (default: the current folder) and prints Performance, Reliability, Maintainability, Security, then Accessibility. |
| `loadwise check --only perf,rel`                                     | Runs only the listed checkers: a comma-separated list of `perf`, `rel`, `maint`, `sec` and `a11y`, in any order.                                      |
| `loadwise check --skip maint`                                        | Runs every checker except the listed ones. `--only` and `--skip` cannot be combined.                                                                  |
| `loadwise perf [args...]`                                            | The full performance checker; `loadwise perf --help` lists its commands and flags. See [Performance checker](#performance-checker).                   |
| `loadwise rel [args...]`                                             | The full reliability checker; `loadwise rel --help` lists its commands and flags. See [Reliability checker](#reliability-checker).                    |
| `loadwise maint [args...]`                                           | The full maintainability checker; `loadwise maint --help` lists its flags. See [Maintainability checker](#maintainability-checker).                   |
| `loadwise sec [args...]`                                             | The full security checker; `loadwise sec --help` lists its flags. See [Security checker](#security-checker).                                          |
| `loadwise a11y [args...]`                                            | The full accessibility checker; `loadwise a11y --help` lists its flags. See [Accessibility checker](#accessibility-checker).                          |
| `loadwise explain <rule-id>`                                         | Shows the default impact, a description and an example change when available. Works offline.                                                          |
| `loadwise fix --yes`                                                 | Scans the current project once and applies eligible edits across the configured checkers.                                                             |
| `loadwise agent init [--mode ask\|auto] [--hook [block\|warn\|off]]` | Writes project instructions for coding agents. Use `--hook` to configure a pre-commit hook.                                                           |

`loadwise check` reuses the previous result for an unchanged Git project from the `loadwise` folder of the OS cache directory. Any edit to a tracked or untracked (not ignored) file, a package install that rewrites `node_modules`, a different flag or a new Loadwise version runs a fresh scan; `LOADWISE_NO_CACHE=1` always scans afresh. Fixes, `--staged`, `--changed-since`, `--online` and `--write-baseline` runs are never cached.

Choose the checkers by name, separated by spaces. With no names, Loadwise uses the project's configured checkers.

```bash
npx loadwise fix --all                            # all generated edits, including review suggestions
npx loadwise fix --all performance                # performance only
npx loadwise fix --all performance security       # performance and security
npx loadwise fix --all reliability                # reliability only
npx loadwise fix --all accessibility              # accessibility only
npx loadwise fix --yes maintainability            # automatic maintainability edits only
```

Manual findings have no generated edit. With `--all`, inspect the resulting diff and run the project's tests, especially for schema changes and edits that alter application behavior.

Each applied fix in a JavaScript or TypeScript file gets a `// Loadwise <rule-id>: <why>` comment above the fixed statement, and the changed lines are formatted with the project's own Prettier, honouring its config and `.prettierignore`; the rest of the file stays byte-identical. Without Prettier in the project the edits are written as generated, with a note. `--no-comments` and `--no-format` turn these off; the per-checker `--fix` takes the same flags. `loadwise fix` also supports `--dry-run` (preview unified diffs without writing), repeatable `--rule <rule-id>` filtering, and `--no-verify-types` (skip Layer-2 semantic type checking on TypeScript projects).

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

Keys use `perf`, `rel`, `maint`, `sec`, or `a11y` followed by the rule ID from the report. A handler receives the finding and the source file text. Return exact, whole-line replacements in that file or return `null` to leave the site manual. Loadwise tries recipes only where it has no built-in fix. It validates the proposed edits together before writing. Recipe files execute as local JavaScript, so run only recipes you trust and keep handlers free of side effects.

To apply automatic fixes across your project, run `npx loadwise fix --yes` from its root. Performance and security share a type-check when both are selected. The command lists manual changes and findings that need individual review by location and ID. A fix that touches lines reserved for review also requires individual review. Loadwise checks the remaining edits together before writing and exits 2 if a selected checker fails or is skipped, source lines have changed, or automatic fixes conflict. A successful application exits 0 even when manual findings remain. Review the diff, run your tests, and use `npx loadwise check` to see what remains.

`check` accepts these flags and passes them to every selected checker:

- `--json` prints one object with a key per selected checker, `{ "performance": report, "reliability": report, "maintainability": report, "security": report, "accessibility": report }`. A checker that was skipped or could not run has `null`.
- `--format text|json|sarif|github` picks the output; `--json` is `--format json`. `sarif` prints SARIF 2.1.0 with one run per checker for GitHub code scanning, and `github` prints `::warning`/`::error`/`::notice` workflow annotations. `loadwise perf`, `loadwise rel`, `loadwise maint`, `loadwise sec` and `loadwise a11y` accept it too. Exit codes do not depend on the format.
- `--include-contextual` also shows lower-priority findings, each with its reason.
- `--staged` or `--changed-since <git-ref>` reports only findings on changed lines.
- `--fail-on contract|all` sets the exit threshold. By default, performance, reliability, security and accessibility fail on displayed findings, and a full maintainability scan fails on contract violations. Changed-line maintainability scans fail on any displayed finding. Configured rule levels can change these defaults.
- `--write-baseline [file]` records the current findings and `--baseline [file]` reports only findings not recorded. The default file is `loadwise-baseline.json` in the checked directory, with one section per checker; `loadwise perf`, `loadwise rel`, `loadwise maint`, `loadwise sec` and `loadwise a11y` take the same flags and read or write only their own section. Entries match on rule, file and flagged code (the finding id), never the line number, with a count per entry so N recorded copies allow N findings. Text output ends with `N baseline findings hidden.` and `--json` adds `baselineHidden`. A full comparison reports the number of unmatched entries in `baselineStale`. A partial comparison, such as a changed-line or single-file scan, reports `null` because unscanned findings may still exist. Refresh the baseline using its original scope and settings. Not combinable with `--fix`, and `--write-baseline` not with `--staged` or `--changed-since`. `loadwise rel migrations` keeps its own per-file baseline.

The performance, reliability, security and accessibility checkers use the directory's `tsconfig.json` or `jsconfig.json`; without one, `check` looks for workspace packages (`package.json` `workspaces`, `pnpm-workspace.yaml` or `lerna.json`) and checks each one's config in one report, grouped per package (a package without a config is checked with the standalone defaults below); `--workspace <name|path>` (repeatable) limits every checker to some packages. For a package with a `package.json` and no config, `check` and `fix` infer its JavaScript and TypeScript source files from the project inventory without writing a config, and check them with ES2022 and NodeNext defaults. A package whose TypeScript sits under a sub-folder's own `tsconfig.json` still needs a config at its root, since those defaults would miss that config's settings. For a JavaScript file without a project config, use `npx loadwise perf path/to/file.js` and `npx loadwise sec path/to/file.js`. For Python, Go, Java, C# or Rust performance checks, run `npx loadwise perf polyglot src` explicitly, and `npx loadwise rel polyglot src` for the reliability patterns. The security checker can still scan Dockerfiles, Compose files and tracked environment files. When performance and reliability are selected together, they share a type-check unless a baseline is being written. Source scans are read-only. When fixes are available, text reports include a `Fix all:` command, such as `npx loadwise perf -p tsconfig.json --fix --only <ids>`, that applies its fixes.

Exit codes: **0** passed, **1** a checker met its exit threshold, **2** invalid input or configuration in any checker, or a scan that skipped a file (see below).

A scan skips a JavaScript or TypeScript file that does not parse, or whose analysis fails, and still reports the findings of every other file. Each skipped file is named in a note on stderr and in a `skippedFiles` array of `{ file, reason }` in `--json` output, and the run exits 2, also with `--fix` and `--write-baseline`. A file that exists but cannot be read (the schema snapshot, `package.json`, a review directive) prints a note on stderr; an absent file stays silent.

On large projects the checkers run with a larger Node memory limit, 60% of the machine's memory, at least 4096 MB and at most 16384 MB (never below Node's own default). A `--max-old-space-size` you set in `NODE_OPTIONS` is never overridden. Direct `loadwise perf`, `loadwise sec` and `loadwise maint` runs re-launch once to apply the limit. If a checker still runs out of memory, `check` prints one line naming it and the limit it had, tells you to raise it with `NODE_OPTIONS=--max-old-space-size=<megabytes>`, and exits 2. When a checker exits 2 because it skipped files, `check` keeps its findings and `skippedFiles` in `--json` output, marks its SARIF run as not successful and emits a GitHub warning for each skipped file. A checker that produced no result is named on stderr and `check` exits 2. The native engine (`--engine native`) uses much less memory on most projects; [PERFORMANCE.md](PERFORMANCE.md) has the measurements.

## Configuration

One optional file, `loadwise.config.json`, sets the defaults for every checker. `loadwise check` looks for it in the checked directory and each checker command (`loadwise perf`, `rel`, `maint`, `sec` or `a11y`) in the project folder; `--config <file>` on `check` (`--loadwise-config <file>` on the checker commands) names another one. Add `$schema` for editor completion and validation.

```json
{
  "$schema": "./node_modules/loadwise/schema/loadwise.config.schema.json",
  "checkers": ["perf", "rel", "maint"],
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
- `performance` holds the query policy (see [Project-defined access policy](#project-defined-access-policy)), and `maintainability` holds the maintainability policy (see [Project rules](#project-rules)). `--policy file.json` and `--config file.json` name a policy file for one run and beat the config sections.
- `--ignore <rule-id>` (repeatable, on `check`, `perf`, `rel` and `maint`) adds a rule to `"off"` for one run and beats the config.

An unknown key or rule id, a wrong level or a malformed section exits with code 2 and lists each problem. Rule ids come from the registered checkers, so a rule id that no checker has yet is rejected. The config applies to source checks and the `polyglot` commands; `rel migrations`, `rel contracts`, `perf db`, `perf traces` and `perf plan` do not read it.

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
| `checkers`     | all             | Passed to `--only`, for example `perf,rel,a11y`.                                                      |
| `path`         | `.`             | Directory to check.                                                                                   |
| `changed-only` | `false`         | `true` passes `--changed-since` with the pull request base commit.                                    |
| `fail-on`      | checker default | Passed to `--fail-on` (`contract` or `all`).                                                          |
| `upload-sarif` | `true`          | Uploads the SARIF report with `github/codeql-action/upload-sarif@v4`; needs `security-events: write`. |
| `annotations`  | `true`          | Prints findings as workflow annotations.                                                              |

The action installs its locked runtime dependencies in a runner temporary directory and runs the source at the selected action ref. SARIF and workflow annotations share one scan. The checker exit code is applied after the SARIF upload step.

## Use with AI coding agents

Ask your coding agent to run Loadwise. On its first check or fix, the CLI gives a recognized agent the review workflow on stderr. A check lets the agent inspect every scoped finding, earlier edit, caller and test. A fix request also lets it apply or adapt justified changes. The agent can read the full workflow with `loadwise agent instructions`. The first run works in a fresh checkout and leaves project instruction files and Git hooks alone.

Loadwise recognizes agent shell markers from Codex, Claude Code, Cursor, Gemini CLI and GitHub Copilot, as well as tools that identify themselves with `AI_AGENT`. An integration that supplies no marker can set `LOADWISE_AGENT=1` in its tool subprocess. Set `LOADWISE_AGENT=0` on a command to disable detection. Commands typed in plain Git Bash or an ordinary IDE terminal run normally. A shell opened inside an agent can inherit its markers.

Agent-run CLI fixes save their actual edited hunks locally from the first fix. For earlier fixes and saved review decisions, run `loadwise agent history` from the checked project, optionally with a checker name such as `maintainability` or `reliability`. History stays under the user's local state directory and can include excerpts of project source. For unrecorded edits, including edits made on another machine, use an earlier report or a known diff.

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

For a standalone JSON scan, pass its checker name, for example `npx loadwise agent verify --checker maint --outcomes outcomes.json maint-scan.json`. Use `perf` for performance and database reports, `rel` for reliability, migration and contract reports, `maint` for maintainability, `sec` for security, and `a11y` for accessibility. Use one checker per invocation for unlabelled standalone reports. Combined scans and history keep their original checker selection.

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

Run `npx loadwise check` to see findings or `npx loadwise fix --yes` to scan and apply automatic fixes. With the language server running in your editor, hover over a finding to see its recommendation. Findings that require judgment remain available for manual review. [Editor setup](#editor-language-server)

### Claude Code plugin

`agent init` gives Claude Code instructions; the plugin makes the check automatic. Install it from inside Claude Code:

```
/plugin marketplace add IbrahimHafez1/loadwise
/plugin install loadwise@loadwise
```

After every `Edit`, `Write` or `MultiEdit` on a `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts` or `.cts` file, or a `.html`, `.htm`, `.vue` or `.svelte` file, a hook runs the project's locally installed `loadwise` on that file (`perf`, `rel` and `sec` on the file, `maint` on the uncommitted changes, keeping that file's findings, and `a11y` on `.tsx`, `.jsx`, `.html`, `.htm`, `.vue` and `.svelte` files) with a 20 second limit. Findings go back to Claude with their ids and `--fix --only <id>` commands for the corresponding checker; a clean file prints nothing. The hook never downloads anything: without a local install, outside a project, on other file types, on a timeout or on any error it exits silently. The plugin also adds a `/loadwise [args]` command for read-only checks and a `/loadwise fix [checker names]` workflow for agent-reviewed remediation.

To turn the hook off, run `/plugin disable loadwise` (or `/plugin uninstall loadwise`).

### Git pre-commit hook

```sh
npx loadwise agent init --hook block   # a commit with new findings fails
npx loadwise agent init --hook warn    # findings are printed, the commit goes through (also plain --hook)
npx loadwise agent init --hook off     # removes only this block
```

The hook runs `loadwise check --staged` from the project folder, so every tool that commits through git sees findings from the selected checkers on the staged lines. It writes a marked block into the hooks folder (honouring `core.hooksPath`) or into `.husky/pre-commit` when `.husky/` exists, appends to a hook you already have, and rerunning it replaces only its own block, including blocks written by earlier releases. With lefthook it edits nothing and prints the command to add. `git commit --no-verify` skips the hook.

## Editor (language server)

`loadwise lsp` is a language server for any editor with a Language Server Protocol client. It shows findings from all five checkers (performance, reliability, maintainability, security and accessibility) as diagnostics, with hovers, fixes, dismissals and code lenses. It needs Node.js 22+ and this package in the project (`npm install --save-dev loadwise`) or on the PATH. Every editor starts it the same way:

```sh
npx loadwise lsp --stdio
```

On Windows, use `npx.cmd` where the editor does not resolve `npx` itself. Choose the file types each editor attaches it to; the snippets below cover JavaScript, TypeScript and Python, and the checkers also read Go, Java, C#, Rust, HTML, Vue and Svelte.

**Neovim 0.11+** (`init.lua`):

```lua
vim.lsp.config('loadwise', {
  cmd = { 'npx', 'loadwise', 'lsp', '--stdio' },
  filetypes = { 'javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'python' },
  root_markers = { 'loadwise.config.json', 'tsconfig.json', 'jsconfig.json', 'package.json', '.git' },
  init_options = { loadwise = { severity = 'default' } },
})
vim.lsp.enable('loadwise')
```

With an older Neovim and nvim-lspconfig, register the same settings as a custom server:

```lua
require('lspconfig.configs').loadwise = {
  default_config = {
    cmd = { 'npx', 'loadwise', 'lsp', '--stdio' },
    filetypes = { 'javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'python' },
    root_dir = require('lspconfig.util').root_pattern('loadwise.config.json', 'tsconfig.json', 'package.json', '.git'),
  },
}
require('lspconfig').loadwise.setup({})
```

**Helix** (`languages.toml`), added beside each language's own server:

```toml
[language-server.loadwise]
command = "npx"
args = ["loadwise", "lsp", "--stdio"]

[[language]]
name = "typescript"
language-servers = ["typescript-language-server", "loadwise"]

[[language]]
name = "python"
language-servers = ["pylsp", "loadwise"]
```

**Zed** (`settings.json`). Zed starts only language servers that an extension registers; with one that registers `loadwise`, these settings choose the command and the languages it runs for:

```json
{
  "lsp": {
    "loadwise": {
      "binary": { "path": "npx", "arguments": ["loadwise", "lsp", "--stdio"] },
      "initialization_options": { "loadwise": { "severity": "default" } }
    }
  },
  "languages": {
    "TypeScript": { "language_servers": ["...", "loadwise"] },
    "Python": { "language_servers": ["...", "loadwise"] }
  }
}
```

**Sublime Text** with the LSP package (**Preferences > Package Settings > LSP > Settings**):

```json
{
  "clients": {
    "loadwise": {
      "enabled": true,
      "command": ["npx", "loadwise", "lsp", "--stdio"],
      "selector": "source.js | source.jsx | source.ts | source.tsx | source.python",
      "initializationOptions": { "loadwise": { "severity": "default" } }
    }
  }
}
```

**Emacs** with eglot. Eglot runs one server per buffer, so for these modes Loadwise takes the place of another server:

```elisp
(with-eval-after-load 'eglot
  (add-to-list 'eglot-server-programs
               '((js-mode js-ts-mode typescript-ts-mode tsx-ts-mode python-mode python-ts-mode)
                 . ("npx" "loadwise" "lsp" "--stdio"))))
```

**VS Code and VSCodium**: install a generic Language Server Protocol client extension from Open VSX and set its server command to `npx loadwise lsp --stdio`. To apply eligible fixes on save, add `"editor.codeActionsOnSave": { "source.fixAll.loadwise": "explicit" }` to your settings.

### What you see

- Each finding is a diagnostic with its checker as the source (`loadwise perf`, `loadwise maint`, `loadwise sec`) and its rule as the code, linked to the rule's documentation. Related locations, such as the other imports of a dependency cycle, are listed with it. Rule levels from `loadwise.config.json` decide the severity: by default declared contract violations are errors and other findings warnings. Live-database findings, which name a table rather than a file, appear on the first line of `package.json`.
- Hover over a finding to read the recommendation on the first line (a source-based rewrite, an illustrative example or a review action), then the original finding and the before and after code, highlighted for the file's language.
- The code actions on a flagged line are **Apply fix: <rule>** when the checker has a rewrite, **Dismiss this finding** and **Dismiss <rule> in this file**, and **Apply all Loadwise fixes in this file** when there are several. Fixes that span several files, or create a migration file, apply all-or-nothing. A fix never overwrites an existing file, and it refuses code that changed since the scan, comparing against the editor's unsaved text. The `source.fixAll.loadwise` action applies every eligible fix in the file as one undoable edit and leaves fixes that need individual review for **Apply fix**.
- Code lenses put **Apply fix** and **Dismiss** above each fixable line, and **Apply all** on the first line of a file with several fixes.
- A dismissed finding stays hidden until its flagged line changes; a rule dismissed for a file stays hidden in that file. Dismissals are saved in `.loadwise/dismissed.json` at the workspace folder root, never in your code, and you can commit the file to share them.

### What gets scanned

Each workspace folder is scanned when the server starts and again after every change: a save in the editor, or a change by git, another editor or a code generator to a source file, `schema.prisma`, a SQL migration, `package.json`, `tsconfig*.json`, `jsconfig*.json`, `loadwise.config.json` or `.loadwise/dismissed.json`. Rapid changes are grouped, and a completed source scan in the project terminal refreshes the editor too. Performance, reliability and accessibility come from the incremental `loadwise perf --watch` process, which re-analyzes only changed files, restarts when a config file or package changes, and falls back to full rescans if it stops. Maintainability and security rerun on each change, and the polyglot rules run when the folder has Python, Go, Java, C# or Rust files. The default project is a root `tsconfig.json` or `jsconfig.json`; in a monorepo, open individual packages as workspace folders or set `project`. Progress appears while a scan runs, and scan counts and errors go to the editor's language server log.

### Commands and settings

| Command                     | Action                                                     |
| --------------------------- | ---------------------------------------------------------- |
| `loadwise.scan`             | Rescan every workspace folder now                          |
| `loadwise.applyFix`         | Apply one fix (from a code action or code lens)            |
| `loadwise.applyAllFixes`    | Apply every eligible fix in a file (its URI as argument)   |
| `loadwise.dismiss`          | Dismiss a finding or a rule in a file                      |
| `loadwise.showDismissed`    | List dismissed findings, with Restore and Restore all      |
| `loadwise.restoreDismissed` | Restore the given dismissal, or every one without argument |

Settings go in the client's `initializationOptions` or its `loadwise` configuration section (per workspace folder when the editor supports it):

| Setting    | Default     | Effect                                                                        |
| ---------- | ----------- | ----------------------------------------------------------------------------- |
| `enabled`  | `true`      | Show diagnostics for the folder                                               |
| `project`  | `""`        | TypeScript or JavaScript project config, relative to the folder               |
| `cli`      | `""`        | Absolute path to another `bin/loadwise.js`, such as a development build       |
| `severity` | `"default"` | `error`, `warning`, `information` or `hint` shows every finding at that level |
| `codeLens` | `true`      | Show the Apply fix and Dismiss code lenses                                    |

# Performance checker

`loadwise perf` finds repeated backend work before deployment or in a recorded request. It checks source code, OpenTelemetry traces and executed database plans. Findings include a location or trace identifier, a rule ID, and a suggested change to evaluate.

## What you get

| Capability                | Command                                  | Needs a database |
| ------------------------- | ---------------------------------------- | ---------------- |
| Source and ORM checks     | `loadwise perf -p tsconfig.json`         | No               |
| Migration safety          | `loadwise rel migrations`                | No               |
| API contract safety       | `loadwise rel contracts`                 | No               |
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
npx loadwise perf node_modules/loadwise/examples/slow.ts
npx loadwise perf node_modules/loadwise/examples/indexed.ts
```

Use the same one-shot commands in CI. Exit **0** means no displayed finding met the fail threshold, **1** means at least one did and **2** means the check could not complete or skipped a file. Add `--json` for structured output.

Source checks summarize contextual findings separately. They include certain one-off blocking calls in CLI startup or unit tests and write advisories in test sources. Use `--include-contextual` to display every candidate and its reason. JSON includes `contextualFindingCount` when any remain after explicit rule exclusions. In the default view this count is additional to the displayed findings. In the expanded view these entries appear in `findings` with a `contextualReason`.

The default `--fail-on all` applies to the displayed findings. For a complete advisory report that only fails CI on a transaction-client or import contract violation, use `npx loadwise rel --include-contextual --fail-on contract`. Performance has no contract rules; `loadwise rel --fail-on contract` enforces `pg-transaction-on-pool`.

| Input                                   | Command after `npx loadwise perf`                                  | Coverage                                                                            |
| --------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| JavaScript or TypeScript                | `-p tsconfig.json`, `--watch -p tsconfig.json` or `src/handler.ts` | Typed database calls, collection algorithms, connections and synchronous Node APIs. |
| Python, Go, Java, C#, Rust              | `polyglot src`                                                     | Five narrowly scoped source patterns powered by a Rust binary.                      |
| OTLP/JSON from any application language | `traces request.otlp.json --threshold 5`                           | Repeated SQL or NoSQL operations, duplicate lookups and Redis/Valkey commands.      |
| Executed PostgreSQL or MongoDB plan     | `plan explain.json`                                                | Inefficient scans, disk sorts and deep pagination at individual plan stages.        |

## Source checks

Run in the directory containing `tsconfig.json` or `jsconfig.json`, pass `-p path/to/config.json`, or give explicit JS/TS files. A project check scans the config's input files and follows project references. Declaration files supply types. A standalone file check uses ES2022 and NodeNext compiler defaults. Use a project config for aliases, custom libraries and JS projects with `allowJs`. When the config Loadwise finds leaves JavaScript files in its folder out because `allowJs` is off, Loadwise still checks them with those standalone defaults and a note names them; set `allowJs` or add a `jsconfig.json` to check them with the project's settings. A config passed with `-p` is checked exactly as it lists its files, and the note names the JavaScript it leaves out.

<!-- loadwise:rules:start checker=performance group=source-checks -->

| Rule                                                                                                                                          | Impact   | What it flags                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="angular-default-change-detection"></a>[`angular-default-change-detection`](docs/rules/angular-default-change-detection.md)             | low      | An Angular component uses default change detection instead of OnPush, so its subtree is re-checked on every event.                       |
| <a id="angular-ngfor-missing-trackby"></a>[`angular-ngfor-missing-trackby`](docs/rules/angular-ngfor-missing-trackby.md)                      | low      | An *ngFor has no trackBy, so a list replaced with new objects recreates the DOM of every item.                                           |
| <a id="angular-subscribe-without-cleanup"></a>[`angular-subscribe-without-cleanup`](docs/rules/angular-subscribe-without-cleanup.md)          | medium   | An RxJS subscription in a component has no completing operator or ngOnDestroy unsubscribe and keeps running after destruction.           |
| <a id="array-repeated-find"></a>[`array-repeated-find`](docs/rules/array-repeated-find.md)                                                    | medium   | An array is searched with find or findIndex repeatedly where a Map lookup would do.                                                      |
| <a id="array-repeated-membership"></a>[`array-repeated-membership`](docs/rules/array-repeated-membership.md)                                  | medium   | An array is tested with includes or indexOf repeatedly where a Set would do.                                                             |
| <a id="dom-layout-thrashing"></a>[`dom-layout-thrashing`](docs/rules/dom-layout-thrashing.md)                                                 | medium   | A loop reads layout metrics and mutates DOM styles or classes, forcing a reflow on each iteration.                                       |
| <a id="dom-listener-without-cleanup"></a>[`dom-listener-without-cleanup`](docs/rules/dom-listener-without-cleanup.md)                         | low      | A window or document listener uses an inline function with no AbortSignal or once, so it can never be removed.                           |
| <a id="dom-unthrottled-scroll-resize"></a>[`dom-unthrottled-scroll-resize`](docs/rules/dom-unthrottled-scroll-resize.md)                      | low      | A scroll, resize, mousemove, wheel or touch listener runs unthrottled work (or is non-passive) on the main thread.                       |
| <a id="express-missing-compression"></a>[`express-missing-compression`](docs/rules/express-missing-compression.md)                            | low      | An Express server registers no response compression middleware.                                                                          |
| <a id="external-call-in-transaction"></a>[`external-call-in-transaction`](docs/rules/external-call-in-transaction.md)                         | high     | An external call is awaited inside a database transaction, holding its connection and locks.                                             |
| <a id="filter-for-existence"></a>[`filter-for-existence`](docs/rules/filter-for-existence.md)                                                 | low      | filter(...).length is used only to test whether any element matches.                                                                     |
| <a id="frontend-barrel-heavy-import"></a>[`frontend-barrel-heavy-import`](docs/rules/frontend-barrel-heavy-import.md)                         | low      | A client module imports the whole of lodash or moment instead of subpaths or a lighter library.                                          |
| <a id="graphql-n-plus-one-resolver"></a>[`graphql-n-plus-one-resolver`](docs/rules/graphql-n-plus-one-resolver.md)                            | high     | A GraphQL field resolver executes a database or HTTP query per parent item without DataLoader batching.                                  |
| <a id="heavy-media-in-request-handler"></a>[`heavy-media-in-request-handler`](docs/rules/heavy-media-in-request-handler.md)                   | medium   | Heavy image (sharp) or PDF rendering runs directly inside an HTTP request handler.                                                       |
| <a id="json-roundtrip-clone"></a>[`json-roundtrip-clone`](docs/rules/json-roundtrip-clone.md)                                                 | low      | A value is deep-cloned with JSON.parse(JSON.stringify(...)) on a request path.                                                           |
| <a id="json-stringify-in-loop"></a>[`json-stringify-in-loop`](docs/rules/json-stringify-in-loop.md)                                           | medium   | JSON.stringify runs inside a loop instead of serializing once or streaming.                                                              |
| <a id="list-count-per-request"></a>[`list-count-per-request`](docs/rules/list-count-per-request.md)                                           | medium   | A list endpoint runs a full count query on every request.                                                                                |
| <a id="list-query-overfetch"></a>[`list-query-overfetch`](docs/rules/list-query-overfetch.md)                                                 | medium   | A list query loads large columns or nested relations without a narrow projection.                                                        |
| <a id="llm-call-without-max-tokens"></a>[`llm-call-without-max-tokens`](docs/rules/llm-call-without-max-tokens.md)                            | medium   | An OpenAI chat or responses call sets no output token limit.                                                                             |
| <a id="loop-copy-accumulator"></a>[`loop-copy-accumulator`](docs/rules/loop-copy-accumulator.md)                                              | medium   | A loop copies its growing result on every iteration.                                                                                     |
| <a id="mongoose-hydrate-for-to-object"></a>[`mongoose-hydrate-for-to-object`](docs/rules/mongoose-hydrate-for-to-object.md)                   | medium   | A Mongoose query hydrates full Documents only to convert them immediately via .toObject() or .toJSON().                                  |
| <a id="mongoose-missing-lean"></a>[`mongoose-missing-lean`](docs/rules/mongoose-missing-lean.md)                                              | medium   | A Mongoose read query is returned or serialized without .lean(), paying full Document hydration overhead.                                |
| <a id="node-event-listener-leak"></a>[`node-event-listener-leak`](docs/rules/node-event-listener-leak.md)                                     | high     | An event listener is registered inside a repeated or per-request context without matching cleanup.                                       |
| <a id="node-sync-compression-in-async"></a>[`node-sync-compression-in-async`](docs/rules/node-sync-compression-in-async.md)                   | medium   | A synchronous zlib call blocks the event loop inside an async function.                                                                  |
| <a id="node-sync-crypto-in-async"></a>[`node-sync-crypto-in-async`](docs/rules/node-sync-crypto-in-async.md)                                  | high     | A synchronous crypto call blocks the event loop inside an async function.                                                                |
| <a id="node-sync-fs-in-async"></a>[`node-sync-fs-in-async`](docs/rules/node-sync-fs-in-async.md)                                              | medium   | A synchronous fs call blocks the event loop inside an async function.                                                                    |
| <a id="node-sync-process-in-async"></a>[`node-sync-process-in-async`](docs/rules/node-sync-process-in-async.md)                               | high     | A synchronous child_process call blocks the event loop inside an async function.                                                         |
| <a id="notification-send-in-loop"></a>[`notification-send-in-loop`](docs/rules/notification-send-in-loop.md)                                  | high     | A push, email or Firebase message is sent once per loop iteration instead of in one batch.                                               |
| <a id="orm-cartesian-include"></a>[`orm-cartesian-include`](docs/rules/orm-cartesian-include.md)                                              | high     | One query joins two or more one-to-many relations, so the returned rows multiply.                                                        |
| <a id="orm-deep-offset"></a>[`orm-deep-offset`](docs/rules/orm-deep-offset.md)                                                                | high     | A list query pages with a large or unbounded offset, so the database reads and discards every skipped row.                               |
| <a id="password-hash-pure-js"></a>[`password-hash-pure-js`](docs/rules/password-hash-pure-js.md)                                              | medium   | bcryptjs hashes passwords in pure JavaScript on the main thread.                                                                         |
| <a id="password-hash-sync-in-async"></a>[`password-hash-sync-in-async`](docs/rules/password-hash-sync-in-async.md)                            | high     | A synchronous bcrypt call blocks the event loop inside an async function.                                                                |
| <a id="pg-count-materialization"></a>[`pg-count-materialization`](docs/rules/pg-count-materialization.md)                                     | medium   | A pg query loads rows only to count them.                                                                                                |
| <a id="pg-filter-materialization"></a>[`pg-filter-materialization`](docs/rules/pg-filter-materialization.md)                                  | medium   | A pg query loads an unbounded result that JavaScript then filters by equality.                                                           |
| <a id="pg-first-materialization"></a>[`pg-first-materialization`](docs/rules/pg-first-materialization.md)                                     | medium   | A pg query loads an unbounded result to read only its first row.                                                                         |
| <a id="pg-query-in-loop"></a>[`pg-query-in-loop`](docs/rules/pg-query-in-loop.md)                                                             | high     | A pg query runs once per loop iteration.                                                                                                 |
| <a id="pg-top-k-materialization"></a>[`pg-top-k-materialization`](docs/rules/pg-top-k-materialization.md)                                     | medium   | A pg query loads an unbounded result that JavaScript sorts to keep the top rows.                                                         |
| <a id="pg-unreleased-checkout"></a>[`pg-unreleased-checkout`](docs/rules/pg-unreleased-checkout.md)                                           | critical | A chained pool checkout loses the client, so it is never released.                                                                       |
| <a id="pool-created-per-request-or-item"></a>[`pool-created-per-request-or-item`](docs/rules/pool-created-per-request-or-item.md)             | critical | A database, Redis, S3, OpenAI, Anthropic or Stripe client or pool is created on a per-request or per-item path.                          |
| <a id="prisma-count-materialization"></a>[`prisma-count-materialization`](docs/rules/prisma-count-materialization.md)                         | medium   | A Prisma query loads rows only to count them.                                                                                            |
| <a id="prisma-filter-materialization"></a>[`prisma-filter-materialization`](docs/rules/prisma-filter-materialization.md)                      | medium   | A Prisma query loads an unbounded result that JavaScript then filters by equality.                                                       |
| <a id="prisma-first-materialization"></a>[`prisma-first-materialization`](docs/rules/prisma-first-materialization.md)                         | medium   | A Prisma query loads an unbounded result to read only its first row.                                                                     |
| <a id="prisma-query-in-loop"></a>[`prisma-query-in-loop`](docs/rules/prisma-query-in-loop.md)                                                 | high     | A Prisma query runs once per loop iteration.                                                                                             |
| <a id="prisma-top-k-materialization"></a>[`prisma-top-k-materialization`](docs/rules/prisma-top-k-materialization.md)                         | medium   | A Prisma query loads an unbounded result that JavaScript sorts to keep the top rows.                                                     |
| <a id="queue-add-in-loop"></a>[`queue-add-in-loop`](docs/rules/queue-add-in-loop.md)                                                          | high     | A job queue add runs once per item instead of one addBulk.                                                                               |
| <a id="react-component-defined-in-component"></a>[`react-component-defined-in-component`](docs/rules/react-component-defined-in-component.md) | medium   | A component is declared inside another component and rendered as an element, so it remounts on every render and loses its state and DOM. |
| <a id="react-context-value-recreated"></a>[`react-context-value-recreated`](docs/rules/react-context-value-recreated.md)                      | low      | An inline object or array literal in Context.Provider value creates a new reference on every render.                                     |
| <a id="react-fetch-in-effect-no-abort"></a>[`react-fetch-in-effect-no-abort`](docs/rules/react-fetch-in-effect-no-abort.md)                   | low      | A fetch in an effect has no AbortController or cleanup, so dependency changes can race and apply stale results.                          |
| <a id="react-index-as-key"></a>[`react-index-as-key`](docs/rules/react-index-as-key.md)                                                       | low      | A list item uses the map index as its React key, which breaks reconciliation when items are inserted or reordered.                       |
| <a id="react-inline-object-in-jsx-prop"></a>[`react-inline-object-in-jsx-prop`](docs/rules/react-inline-object-in-jsx-prop.md)                | low      | An inline object literal is passed to a memo() component, creating a new reference each render and defeating the memo.                   |
| <a id="react-missing-cleanup"></a>[`react-missing-cleanup`](docs/rules/react-missing-cleanup.md)                                              | medium   | An effect starts a global listener, interval, socket or endless subscription and returns no cleanup, so it leaks on every remount.       |
| <a id="rebuild-lookup-in-loop"></a>[`rebuild-lookup-in-loop`](docs/rules/rebuild-lookup-in-loop.md)                                           | high     | A Set or Map is rebuilt from the same data on every loop iteration.                                                                      |
| <a id="redis-command-in-loop"></a>[`redis-command-in-loop`](docs/rules/redis-command-in-loop.md)                                              | high     | A per-key Redis command runs once per loop iteration.                                                                                    |
| <a id="redis-keys-command"></a>[`redis-keys-command`](docs/rules/redis-keys-command.md)                                                       | high     | A Redis KEYS call blocks the server while it scans the keyspace.                                                                         |
| <a id="reduce-copy-accumulator"></a>[`reduce-copy-accumulator`](docs/rules/reduce-copy-accumulator.md)                                        | medium   | A reduce callback copies its growing accumulator on every step.                                                                          |
| <a id="sequential-http-in-loop"></a>[`sequential-http-in-loop`](docs/rules/sequential-http-in-loop.md)                                        | high     | Independent HTTP requests are awaited one at a time inside a loop.                                                                       |
| <a id="serial-awaits-in-literal"></a>[`serial-awaits-in-literal`](docs/rules/serial-awaits-in-literal.md)                                     | medium   | An array or object literal awaits two or more independent values one after another.                                                      |
| <a id="service-query-in-loop"></a>[`service-query-in-loop`](docs/rules/service-query-in-loop.md)                                              | high     | A loop calls a project function that runs several database operations per item.                                                          |
| <a id="session-memory-store"></a>[`session-memory-store`](docs/rules/session-memory-store.md)                                                 | high     | An express-session middleware has no store, so sessions live in process memory.                                                          |
| <a id="sql-select-star-in-query"></a>[`sql-select-star-in-query`](docs/rules/sql-select-star-in-query.md)                                     | low      | A raw SQL query selects every column with SELECT * instead of the columns it needs.                                                      |
| <a id="unbounded-list-query"></a>[`unbounded-list-query`](docs/rules/unbounded-list-query.md)                                                 | high     | A request handler returns query results without an apparent row limit.                                                                   |
| <a id="unbounded-module-cache"></a>[`unbounded-module-cache`](docs/rules/unbounded-module-cache.md)                                           | medium   | A long-lived cache accepts dynamic keys without an apparent bound or eviction.                                                           |
| <a id="vue-v-for-missing-key"></a>[`vue-v-for-missing-key`](docs/rules/vue-v-for-missing-key.md)                                              | low      | A list rendered with h() has no key prop, forcing inefficient patching.                                                                  |
| <a id="vue-watch-missing-cleanup"></a>[`vue-watch-missing-cleanup`](docs/rules/vue-watch-missing-cleanup.md)                                  | medium   | onMounted registers a global listener, timer or observer with no unmount cleanup.                                                        |
| <a id="whole-payload-in-memory"></a>[`whole-payload-in-memory`](docs/rules/whole-payload-in-memory.md)                                        | medium   | An operation loads an entire file, stream, or response into memory.                                                                      |

<!-- loadwise:rules:end -->

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

<!-- loadwise:rules:start checker=performance group=orm-and-query-integrity-checks -->

| Rule                                                                                                                                 | Impact | What it flags                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------- |
| <a id="drizzle-query-in-loop"></a>[`drizzle-query-in-loop`](docs/rules/drizzle-query-in-loop.md)                                     | high   | A Drizzle statement executes once per loop iteration.                                    |
| <a id="guard-query-per-request"></a>[`guard-query-per-request`](docs/rules/guard-query-per-request.md)                               | medium | A guard or per-request hook runs a database query before every handler.                  |
| <a id="orm-count-materialization"></a>[`orm-count-materialization`](docs/rules/orm-count-materialization.md)                         | medium | A TypeORM, Sequelize, Mongoose, Knex or Kysely query loads rows only to count them.      |
| <a id="orm-query-in-loop"></a>[`orm-query-in-loop`](docs/rules/orm-query-in-loop.md)                                                 | high   | A TypeORM, Sequelize, Mongoose, Knex or Kysely operation runs once per loop iteration.   |
| <a id="prisma-distinct-in-memory"></a>[`prisma-distinct-in-memory`](docs/rules/prisma-distinct-in-memory.md)                         | medium | Prisma findMany with distinct reads every matching row and de-duplicates in memory.      |
| <a id="prisma-relation-count-in-list"></a>[`prisma-relation-count-in-list`](docs/rules/prisma-relation-count-in-list.md)             | medium | A paged Prisma findMany selects a relation _count computed over the whole related table. |
| <a id="typeorm-existence-materialization"></a>[`typeorm-existence-materialization`](docs/rules/typeorm-existence-materialization.md) | medium | A TypeORM entity is loaded only to check whether it exists.                              |
| <a id="typeorm-load-then-save"></a>[`typeorm-load-then-save`](docs/rules/typeorm-load-then-save.md)                                  | high   | A TypeORM entity is loaded only to change a few fields and save it back.                 |
| <a id="typeorm-transaction-in-loop"></a>[`typeorm-transaction-in-loop`](docs/rules/typeorm-transaction-in-loop.md)                   | high   | A loop calls a helper that starts one TypeORM transaction per item.                      |
| <a id="typeorm-wide-projection"></a>[`typeorm-wide-projection`](docs/rules/typeorm-wide-projection.md)                               | low    | A TypeORM DTO projection loads wide columns it never uses.                               |

<!-- loadwise:rules:end -->

For Prisma, building an array of lazy queries alone is quiet. A sequential `await` inside a loop can trigger the rule. Same-tick `findUnique` callbacks can use Prisma's own batching, so these are left to runtime traces. [Prisma Client reference](https://www.prisma.io/docs/orm/reference/prisma-client-reference#prismapromise-behavior) · [Prisma transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions) · [node-postgres transactions](https://node-postgres.com/features/transactions) · [Drizzle conditional filters](https://orm.drizzle.team/docs/guides/conditional-filters-in-query)

### Project-defined access policy

Put the policy in the `performance` section of `loadwise.config.json` beside the selected project config (in the working directory for explicit source files), or pass `--policy path/to/file.json`. A policy can use just the sections the project needs (`prismaScopes`, `drizzleScopes`, `parallelReads`, and `fireAndForget`, a list of helper names that `floating-promise` accepts without an await). Duplicate JSON keys within the same object produce a configuration error. [Example policy](examples/query-policy.json)

### Async work and sorting

<!-- loadwise:rules:start checker=performance group=async-work-and-sorting -->

| Rule                                                                                                                           | Impact | What it flags                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------- |
| <a id="await-before-early-exit"></a>[`await-before-early-exit`](docs/rules/await-before-early-exit.md)                         | medium | An awaited read runs before a guard that returns or throws without using its result.         |
| <a id="count-then-page-serial"></a>[`count-then-page-serial`](docs/rules/count-then-page-serial.md)                            | low    | A count and a page query with the same filter run one after the other.                       |
| <a id="drizzle-last-insert-id"></a>[`drizzle-last-insert-id`](docs/rules/drizzle-last-insert-id.md)                            | medium | A MySQL insert is followed by an extra query for its generated ID.                           |
| <a id="known-reads-awaited-serially"></a>[`known-reads-awaited-serially`](docs/rules/known-reads-awaited-serially.md)          | medium | Two independent reads from a configured parallelReads group are awaited one after the other. |
| <a id="numeric-sort-for-extreme"></a>[`numeric-sort-for-extreme`](docs/rules/numeric-sort-for-extreme.md)                      | low    | A numeric sort is used only to read the smallest or largest value.                           |
| <a id="prisma-count-for-existence"></a>[`prisma-count-for-existence`](docs/rules/prisma-count-for-existence.md)                | medium | A Prisma query counts all matches only to check whether any row exists.                      |
| <a id="promise-combinator-serial-await"></a>[`promise-combinator-serial-await`](docs/rules/promise-combinator-serial-await.md) | medium | Promise.all receives calls that were already awaited one by one.                             |
| <a id="repeated-workbook-decode"></a>[`repeated-workbook-decode`](docs/rules/repeated-workbook-decode.md)                      | medium | A workflow decodes the same input with ExcelJS more than once.                               |
| <a id="typeorm-unused-count"></a>[`typeorm-unused-count`](docs/rules/typeorm-unused-count.md)                                  | medium | A TypeORM count-and-list query discards its total in immediate tuple destructuring.          |

<!-- loadwise:rules:end -->

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

`--fix` answers are **y**es, **n**o, **a**ll remaining and **q**uit. Without a terminal it requires `--yes`. `--fix` cannot be combined with `--watch`, or with `--json` except with `--only`, and `--yes` is valid only with `--fix`. A fix applies only where the original lines still exist, so code that changed since the scan is refused and a change already in the file is reported as already applied. A fix never overwrites an existing file. Like `loadwise fix`, it adds a why-comment above each fixed statement and formats the changed lines with the project's Prettier; `--no-comments` and `--no-format` turn these off. Review the diff and run your tests afterwards. Rewrites that narrow a whole-table Drizzle update to rows with differing values require individual review because the change can affect locking, triggers and affected-row counts. Upload size limits also require individual review. So does the Mongoose `.lean()` rewrite, because a lean result skips schema defaults, getters and virtuals. The 10 MiB example can reject valid uploads, so check the endpoint's file requirements and any existing gateway or Multer limits before applying it.

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

## Schema-aware index checks

The source checker reads the project's ORM schema (Prisma, Drizzle, TypeORM, Sequelize, Mongoose) and compares declared indexes with the queries it finds.

<!-- loadwise:rules:start checker=performance group=schema-aware-index-checks -->

| Rule                                                                                                         | Impact | What it flags                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------- |
| <a id="index-missing-filter"></a>[`index-missing-filter`](docs/rules/index-missing-filter.md)                | high   | A query filters on a column that no index leads with.                                                            |
| <a id="index-missing-foreign-key"></a>[`index-missing-foreign-key`](docs/rules/index-missing-foreign-key.md) | high   | A foreign key column in the schema has no index.                                                                 |
| <a id="index-missing-order"></a>[`index-missing-order`](docs/rules/index-missing-order.md)                   | medium | A query orders by columns that no index serves in that order.                                                    |
| <a id="index-redundant-prefix"></a>[`index-redundant-prefix`](docs/rules/index-redundant-prefix.md)          | low    | An index repeats the leading columns of a longer index on the same table, adding write cost for no read benefit. |
| <a id="index-unusable-expression"></a>[`index-unusable-expression`](docs/rules/index-unusable-expression.md) | high   | A function or expression on an indexed column keeps the index from being used.                                   |
| <a id="index-unusable-pattern"></a>[`index-unusable-pattern`](docs/rules/index-unusable-pattern.md)          | high   | A predicate such as a leading-wildcard LIKE cannot use an ordinary index.                                        |

<!-- loadwise:rules:end -->

Each suggested index carries one explicit name, used both in the ORM snippet (`@@index([a, b], map: "<name>")`, `@Index('<name>', ['a', 'b'])`, `{ name: '<name>', fields: [...] }`, `index('<name>')`, `schema.index({ a: 1 }, { name: '<name>' })`) and in the `CREATE INDEX CONCURRENTLY` statement for a live database, so building it by hand and then generating a migration does not create a duplicate. A fix that adds an index to a Prisma, TypeORM or Drizzle model says to generate a migration for it.

Pass `--schema snapshot.json` (written by `db --schema-snapshot`) to refine them with real table sizes and the measured round trip, which also feeds the Impact line of `*-query-in-loop` findings. Without a snapshot, the checks run from the source schema alone.

## Polyglot source checks

`npx loadwise perf polyglot src` accepts directories or individual `.py`, `.go`, `.java`, `.cs` and `.rs` files. It uses the optional ast-grep native binary and its syntax-tree patterns. `npx loadwise rel polyglot src` runs the reliability patterns, listed under [Reliability checker](#reliability-checker), on the same files. Language-specific aliases and wrappers can fall outside a pattern. [ast-grep](https://ast-grep.github.io/)

Performance and maintainability scans retry files when the bundled parser rejects a Java marker annotation before varargs or a C# 14 conditional member assignment (`=`) in a simple identifier chain. The retry uses a position-preserving copy in memory and still fails if the parser reports a syntax error.

<!-- loadwise:rules:start checker=performance group=polyglot-source-checks -->

| Rule                                                                                                                        | Impact | What it flags                                                                          |
| --------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| <a id="csharp-fixed-regex-in-loop"></a>[`csharp-fixed-regex-in-loop`](docs/rules/csharp-fixed-regex-in-loop.md)             | medium | A C# Regex with a fixed pattern is constructed inside a loop.                          |
| <a id="csharp-string-concat-in-loop"></a>[`csharp-string-concat-in-loop`](docs/rules/csharp-string-concat-in-loop.md)       | medium | String concatenation in a C# loop allocates repeatedly; use StringBuilder.             |
| <a id="go-fixed-regexp-in-loop"></a>[`go-fixed-regexp-in-loop`](docs/rules/go-fixed-regexp-in-loop.md)                      | medium | A Go regexp with a fixed pattern is compiled inside a loop.                            |
| <a id="go-sql-query-in-loop"></a>[`go-sql-query-in-loop`](docs/rules/go-sql-query-in-loop.md)                               | high   | A Go database query executes inside a loop instead of batching.                        |
| <a id="go-string-concat-in-loop"></a>[`go-string-concat-in-loop`](docs/rules/go-string-concat-in-loop.md)                   | medium | String concatenation in a Go loop allocates repeatedly; use strings.Builder.           |
| <a id="java-fixed-regex-in-loop"></a>[`java-fixed-regex-in-loop`](docs/rules/java-fixed-regex-in-loop.md)                   | medium | A Java Pattern with a fixed pattern is compiled inside a loop.                         |
| <a id="java-jdbc-query-in-loop"></a>[`java-jdbc-query-in-loop`](docs/rules/java-jdbc-query-in-loop.md)                      | high   | A JDBC query executes inside a Java loop instead of batching.                          |
| <a id="java-string-concat-in-loop"></a>[`java-string-concat-in-loop`](docs/rules/java-string-concat-in-loop.md)             | medium | String concatenation in a Java loop allocates repeatedly; use StringBuilder.           |
| <a id="python-blocking-sleep-in-async"></a>[`python-blocking-sleep-in-async`](docs/rules/python-blocking-sleep-in-async.md) | high   | A blocking time.sleep call runs inside a Python async def function.                    |
| <a id="python-copy-growing-list"></a>[`python-copy-growing-list`](docs/rules/python-copy-growing-list.md)                   | medium | A Python loop rebuilds a growing list with items = items + [value].                    |
| <a id="python-fixed-regex-in-loop"></a>[`python-fixed-regex-in-loop`](docs/rules/python-fixed-regex-in-loop.md)             | low    | A Python loop compiles a fixed pattern with re.compile on every iteration.             |
| <a id="python-n-plus-one-orm-loop"></a>[`python-n-plus-one-orm-loop`](docs/rules/python-n-plus-one-orm-loop.md)             | high   | An ORM query executes inside a Python loop instead of using eager loading or batching. |
| <a id="python-sync-requests-in-async"></a>[`python-sync-requests-in-async`](docs/rules/python-sync-requests-in-async.md)    | high   | A blocking requests HTTP call runs inside a Python async def function.                 |
| <a id="python-unbounded-comprehension"></a>[`python-unbounded-comprehension`](docs/rules/python-unbounded-comprehension.md) | medium | A Python list comprehension materializes an unbounded collection in memory.            |
| <a id="rust-clone-in-loop"></a>[`rust-clone-in-loop`](docs/rules/rust-clone-in-loop.md)                                     | low    | Cloning values inside a Rust loop adds avoidable heap allocations.                     |
| <a id="rust-fixed-regex-in-loop"></a>[`rust-fixed-regex-in-loop`](docs/rules/rust-fixed-regex-in-loop.md)                   | medium | A Rust Regex with a fixed pattern is compiled inside a loop.                           |
| <a id="rust-format-in-loop"></a>[`rust-format-in-loop`](docs/rules/rust-format-in-loop.md)                                  | low    | Calling format! inside a Rust loop allocates a new String on every iteration.          |

<!-- loadwise:rules:end -->

## Trace checks in other languages and databases

Supply a local **OTLP/JSON trace export** with `resourceSpans → scopeSpans → spans`. An OpenTelemetry Collector with a file export can produce this format. The CLI accepts one export object per invocation. For a collector output containing multiple JSON lines, pass the relevant export object for the request. Spans split across separate invocations count independently.

Try `npx loadwise perf traces node_modules/loadwise/examples/repeated-db.otlp.json`. The example reports five similar MongoDB operations under one parent. The trace rules use current and legacy database attributes and deduplicate span IDs.

<!-- loadwise:rules:start checker=performance group=trace-checks-in-other-languages-and-databases -->

| Rule                                                                                       | Impact | What it flags                                                       |
| ------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------- |
| <a id="duplicate-key-read"></a>[`duplicate-key-read`](docs/rules/duplicate-key-read.md)    | medium | A trace repeats the same key or row read under one parent span.     |
| <a id="redis-keys-scan"></a>[`redis-keys-scan`](docs/rules/redis-keys-scan.md)             | high   | A trace shows a Redis KEYS command scanning the keyspace.           |
| <a id="redis-repeated-read"></a>[`redis-repeated-read`](docs/rules/redis-repeated-read.md) | medium | A trace shows repeated sibling Redis GET or HGET calls.             |
| <a id="repeated-db-span"></a>[`repeated-db-span`](docs/rules/repeated-db-span.md)          | high   | A trace shows many similar sibling database calls under one parent. |

<!-- loadwise:rules:end -->

Matching keys in two reads are a reason to consider **request-local** reuse when authorization, freshness and ordering allow it. Keep existing telemetry redaction. A redacted key can still support a batching finding. Reports contain span IDs and counts and omit raw SQL, parameters and keys. Check `scannedSpans` and `eligibleDbSpans` when interpreting a clean result. Sampling, missing parents, different literal values and coarse summaries affect grouping. [OpenTelemetry database spans](https://opentelemetry.io/docs/specs/semconv/db/database-spans/) · [OTLP JSON encoding](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding)

## Executed query plans

Feed the CLI a JSON file from PostgreSQL `EXPLAIN (ANALYZE, FORMAT JSON)` or MongoDB `explain("executionStats")`. For example, run `npx loadwise perf plan node_modules/loadwise/examples/postgres-plan.json`. The checker reads the file locally. PostgreSQL's `ANALYZE` option executes the statement when you collect the plan. [PostgreSQL EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html) · [MongoDB explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)

<!-- loadwise:rules:start checker=performance group=executed-query-plans -->

| Rule                                                                                             | Impact | What it flags                                                        |
| ------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------- |
| <a id="mongo-collection-scan"></a>[`mongo-collection-scan`](docs/rules/mongo-collection-scan.md) | high   | A MongoDB plan scans many documents for each one it returns.         |
| <a id="mongo-deep-skip"></a>[`mongo-deep-skip`](docs/rules/mongo-deep-skip.md)                   | high   | A MongoDB query skips past many documents to return a page.          |
| <a id="mongo-disk-sort"></a>[`mongo-disk-sort`](docs/rules/mongo-disk-sort.md)                   | medium | A MongoDB sort spilled to disk.                                      |
| <a id="pg-deep-offset"></a>[`pg-deep-offset`](docs/rules/pg-deep-offset.md)                      | high   | A PostgreSQL plan walks past many rows with OFFSET to return a page. |
| <a id="pg-disk-sort"></a>[`pg-disk-sort`](docs/rules/pg-disk-sort.md)                            | medium | A PostgreSQL sort spilled to disk.                                   |
| <a id="pg-sequential-scan"></a>[`pg-sequential-scan`](docs/rules/pg-sequential-scan.md)          | high   | A PostgreSQL plan scans many rows for each one it returns.           |

<!-- loadwise:rules:end -->

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

Rules: `db-unindexed-foreign-key`, `db-unused-index`, `db-duplicate-index`, `db-seq-scan-heavy-table`, `db-slow-query-plan`, `db-missing-index` and, for MongoDB, `mongo-collection-scan-observed`. `--include-contextual`, `--ignore RULE` and `--json` work as in the other commands.

<!-- loadwise:rules:start checker=performance group=database-inspection-optional -->

| Rule                                                                                                                        | Impact | What it flags                                                                |
| --------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| <a id="db-duplicate-index"></a>[`db-duplicate-index`](docs/rules/db-duplicate-index.md)                                     | low    | A database index is covered by another index on the same table.              |
| <a id="db-missing-index"></a>[`db-missing-index`](docs/rules/db-missing-index.md)                                           | high   | A query plan scans a table that a suggested index would let it seek.         |
| <a id="db-seq-scan-heavy-table"></a>[`db-seq-scan-heavy-table`](docs/rules/db-seq-scan-heavy-table.md)                      | high   | A large table is read by many sequential scans on the live database.         |
| <a id="db-slow-query-plan"></a>[`db-slow-query-plan`](docs/rules/db-slow-query-plan.md)                                     | high   | One of the slowest statements reads a table with a full table scan.          |
| <a id="db-unindexed-foreign-key"></a>[`db-unindexed-foreign-key`](docs/rules/db-unindexed-foreign-key.md)                   | high   | A foreign key on the live database has no index that leads with its columns. |
| <a id="db-unused-index"></a>[`db-unused-index`](docs/rules/db-unused-index.md)                                              | low    | A database index has not been scanned since statistics were last reset.      |
| <a id="mongo-collection-scan-observed"></a>[`mongo-collection-scan-observed`](docs/rules/mongo-collection-scan-observed.md) | high   | Profiled MongoDB operations scanned a whole collection.                      |

<!-- loadwise:rules:end -->

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

## Verification and benchmarks

Integration checks used PostgreSQL 18.0 and MongoDB 8.2.3. Each engine examined 20,000 records for one match before an index was added. The corresponding indexed read passed. In both databases a deep page walked 15,010 entries to return ten, and the equivalent keyset query passed. Both engines also produced a disk-sort finding. MongoDB's live test used classic execution stages.

On Redis 7.2.16, the CLI flagged a real `KEYS` call and eight redacted `GET` calls. A test hook exposing only a synthetic key let it identify eight duplicate reads. A single request-local read returned the same eight values and passed. Python SQLite instrumentation separately verified nine statements versus one batched statement for the same eight result rows.

Use Node.js 22.13+ for the full development workflow, including the in-memory SQLite benchmark.

### Source conventions

The CLI and checkers are TypeScript (`.ts`) compiled in place to ES modules (`.js`, not committed) by `npm run build`, while the security example tables under `lib/security/examples/` are `.cts` compiled to CommonJS (`.cjs`); `npm test` builds first and `npm run typecheck` checks without emitting. Import with the runtime extension (`.js` or `.cjs`). The compiler runs in `strict` mode.

- Write ES `import`/`export`, with imports at the top of the file. Oxlint rejects `require()`. Where load order or startup cost forbids a top-level import (the compiler must be chosen before the rules load, and `maint --staged` must not load TypeScript), load lazily in an async function with `await import()`.
- No `any` and no `as` assertions (`as const` is fine) in new code. Narrow with type guards, give a function a precise type, or use overloads. A deliberate exception needs a lint-disable comment that says why.
- Types shared by two or more files live in the `types/` folder of their area (`lib/performance/types/`, `lib/security/types/`, `lib/maintainability/types/`, `lib/shared/types/`, `test/types/`), one topic per file. Cross-pillar types are in `lib/shared/types.ts`. A type used by one file stays in that file.
- Comments wrap at 100 columns, and Prettier formats everything. `.vscode/settings.json` formats on save, and the pre-commit hook in `hooks/` formats and lints staged files (`npm install` enables it).

```sh
npm ci
npm test
node bin/loadwise.js perf -p examples
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
npm --prefix test/performance/integration/orms install --ignore-scripts --omit=optional --no-audit --no-fund
npm --prefix test/performance/integration/orms run verify -- --native
```

The large benchmark checks 3,200 generated source files and verifies expected diagnostics. The performance report also covers a 1,180-file NestJS checkout. [Measurements and methodology](PERFORMANCE.md)

## References

Prisma documents per-item queries and batching. Node documents the event-loop effects of synchronous file I/O. [Prisma query optimization](https://www.prisma.io/docs/orm/v6/prisma-client/queries/query-optimization-performance) · [Node event loop guidance](https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop)

Repeated lookups can benefit from a reusable membership index. Repeated growing copies can become quadratic. Biome already includes a lint rule for accumulating spread. [JavaScript Set](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set) · [Array.reduce](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/reduce#when_to_not_use_reduce) · [Biome rule](https://biomejs.dev/linter/rules/no-accumulating-spread/javascript/)

Sentry also has an N+1 detector that considers sequential spans and their total duration. This package's local trace check groups similar sibling calls, including concurrent calls. [Sentry N+1 detection](https://docs.sentry.io/product/issues/issue-details/performance-issues/n-one-queries/)

# Reliability checker

`loadwise rel` finds code that fails at runtime or under concurrency: unhandled rejections, swallowed errors, races, missing timeouts and idempotency, transactions that escape their client, unsafe migrations and breaking API changes. It shares the source check of `loadwise perf`, so project discovery, policy, config, engines, baselines and fix flags are the same, and `loadwise check` type-checks the project once for both. Run it with `npx loadwise rel -p tsconfig.json`; `npx loadwise rel --help` lists every flag.

## Source rules

The rules from `pg-transaction-on-pool` to `swallowed-error` moved from the performance and maintainability checkers with the same ids, so existing `// loadwise-reviewed` comments, `--ignore` flags and config `rules` entries keep working. Migration and API contract rules are described in [Migration safety](#migration-safety) and [API contract safety](#api-contract-safety). `csharp-async-void` and the `python-`, `go-`, `java-`, `csharp-` and `rust-` rules come from `loadwise rel polyglot`, which needs the optional ast-grep executable.

<!-- loadwise:rules:start checker=reliability group=source-rules -->

| Rule                                                                                                                                          | Impact   | What it flags                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="assignment-in-condition"></a>[`assignment-in-condition`](docs/rules/assignment-in-condition.md)                                        | high     | A condition assigns with = where a comparison was probably meant.                                                                           |
| <a id="async-callback-unhandled-rejection"></a>[`async-callback-unhandled-rejection`](docs/rules/async-callback-unhandled-rejection.md)       | high     | An async callback given to an event emitter, timer or scheduler has no error handling, so a rejection is unhandled.                         |
| <a id="async-route-unhandled-rejection"></a>[`async-route-unhandled-rejection`](docs/rules/async-route-unhandled-rejection.md)                | high     | An Express 4 async route handler has no error handling, so a rejection never reaches the error middleware.                                  |
| <a id="browser-not-closed"></a>[`browser-not-closed`](docs/rules/browser-not-closed.md)                                                       | high     | A Playwright or Puppeteer browser is not closed in a finally block, so an error leaves the process running.                                 |
| <a id="check-then-update-race"></a>[`check-then-update-race`](docs/rules/check-then-update-race.md)                                           | high     | A Mongoose or Sequelize document's numeric field is read, changed in JavaScript and saved without a transaction, losing concurrent updates. |
| <a id="child-process-without-error-listener"></a>[`child-process-without-error-listener`](docs/rules/child-process-without-error-listener.md) | high     | A spawned child process has no 'error' listener, so a failed spawn crashes the parent process.                                              |
| <a id="csharp-async-void"></a>[`csharp-async-void`](docs/rules/csharp-async-void.md)                                                          | high     | An async void method cannot be awaited and can crash the process on unhandled exceptions.                                                   |
| <a id="csharp-disposable-without-using"></a>[`csharp-disposable-without-using`](docs/rules/csharp-disposable-without-using.md)                | medium   | A C# stream, connection or other IDisposable is created without using, so an exception leaks it.                                            |
| <a id="discarded-error-result"></a>[`discarded-error-result`](docs/rules/discarded-error-result.md)                                           | high     | A call discards a typed Either or Result that can carry a failure as a value.                                                               |
| <a id="drizzle-unfiltered-write"></a>[`drizzle-unfiltered-write`](docs/rules/drizzle-unfiltered-write.md)                                     | critical | A Drizzle update or delete executes without an effective where clause.                                                                      |
| <a id="drizzle-write-preflight"></a>[`drizzle-write-preflight`](docs/rules/drizzle-write-preflight.md)                                        | medium   | A separate existence check before a Drizzle write can race with another request.                                                            |
| <a id="error-logged-without-stack"></a>[`error-logged-without-stack`](docs/rules/error-logged-without-stack.md)                               | low      | A catch block logs only error.message and carries on, so the stack trace is lost.                                                           |
| <a id="error-rethrown-without-cause"></a>[`error-rethrown-without-cause`](docs/rules/error-rethrown-without-cause.md)                         | low      | A catch block throws a new error without the caught one, so the original message and stack are lost.                                        |
| <a id="file-handle-not-closed"></a>[`file-handle-not-closed`](docs/rules/file-handle-not-closed.md)                                           | high     | A FileHandle from fs/promises open() is not closed on every path, leaking a file descriptor.                                                |
| <a id="find-then-create-race"></a>[`find-then-create-race`](docs/rules/find-then-create-race.md)                                              | high     | A lookup by key is followed by an insert with that key, with no unique constraint to stop duplicates.                                       |
| <a id="floating-promise"></a>[`floating-promise`](docs/rules/floating-promise.md)                                                             | high     | A promise-returning call is neither awaited, returned nor handled, so its failure goes unseen.                                              |
| <a id="go-defer-before-error-check"></a>[`go-defer-before-error-check`](docs/rules/go-defer-before-error-check.md)                            | high     | A Go defer closes a resource before its error is checked, so a failed open dereferences nil.                                                |
| <a id="go-error-discarded"></a>[`go-error-discarded`](docs/rules/go-error-discarded.md)                                                       | high     | A Go error result is assigned to the blank identifier and never checked.                                                                    |
| <a id="http-call-without-timeout"></a>[`http-call-without-timeout`](docs/rules/http-call-without-timeout.md)                                  | high     | A fetch or axios call has no timeout or abort signal.                                                                                       |
| <a id="interval-not-cleared"></a>[`interval-not-cleared`](docs/rules/interval-not-cleared.md)                                                 | medium   | A setInterval handle is discarded or never cleared, so the timer outlives its owner.                                                        |
| <a id="invalid-typeof-comparison"></a>[`invalid-typeof-comparison`](docs/rules/invalid-typeof-comparison.md)                                  | high     | A typeof result is compared to a string typeof never returns, so the check never matches.                                                   |
| <a id="java-resource-without-try"></a>[`java-resource-without-try`](docs/rules/java-resource-without-try.md)                                  | high     | A Java stream, reader or connection is opened outside try-with-resources, so an exception leaks it.                                         |
| <a id="json-parse-unguarded"></a>[`json-parse-unguarded`](docs/rules/json-parse-unguarded.md)                                                 | medium   | JSON.parse runs on outside input with no try/catch, so malformed input throws where it is not handled.                                      |
| <a id="loop-index-past-length"></a>[`loop-index-past-length`](docs/rules/loop-index-past-length.md)                                           | high     | A loop runs its index up to and including length, so the last pass reads past the end.                                                      |
| <a id="mongoose-aggregate-uncast-id"></a>[`mongoose-aggregate-uncast-id`](docs/rules/mongoose-aggregate-uncast-id.md)                         | high     | A Mongoose aggregate $match compares _id to an uncast string instead of an ObjectId.                                                        |
| <a id="nan-comparison"></a>[`nan-comparison`](docs/rules/nan-comparison.md)                                                                   | high     | A value is compared to NaN with an equality operator, which is never true.                                                                  |
| <a id="next-server-env-in-client"></a>[`next-server-env-in-client`](docs/rules/next-server-env-in-client.md)                                  | high     | A 'use client' file reads a process.env variable without the NEXT_PUBLIC_ prefix, so it is unavailable in the browser by default.           |
| <a id="payment-missing-idempotency-key"></a>[`payment-missing-idempotency-key`](docs/rules/payment-missing-idempotency-key.md)                | high     | A Stripe call that moves money has no idempotency key, so a retry can charge or pay out twice.                                              |
| <a id="pg-transaction-on-pool"></a>[`pg-transaction-on-pool`](docs/rules/pg-transaction-on-pool.md)                                           | critical | A transaction statement is sent to a pool, so its statements can run on different connections.                                              |
| <a id="pool-without-connection-timeout"></a>[`pool-without-connection-timeout`](docs/rules/pool-without-connection-timeout.md)                | medium   | A pg Pool or Client sets no connectionTimeoutMillis, so its default of 0 waits for a connection forever.                                    |
| <a id="prisma-dependent-writes"></a>[`prisma-dependent-writes`](docs/rules/prisma-dependent-writes.md)                                        | high     | Adjacent Prisma creates pass a value from the first record into the next write.                                                             |
| <a id="prisma-read-modify-write"></a>[`prisma-read-modify-write`](docs/rules/prisma-read-modify-write.md)                                     | critical | A Prisma read feeds a numeric update of the same row, losing concurrent updates.                                                            |
| <a id="prisma-transaction-client-escape"></a>[`prisma-transaction-client-escape`](docs/rules/prisma-transaction-client-escape.md)             | critical | A Prisma call inside an interactive transaction uses the outer client instead of the transaction client.                                    |
| <a id="promise-return-escapes-catch"></a>[`promise-return-escapes-catch`](docs/rules/promise-return-escapes-catch.md)                         | high     | Returning a promise directly from a protected try block can bypass its catch on rejection.                                                  |
| <a id="python-bare-except"></a>[`python-bare-except`](docs/rules/python-bare-except.md)                                                       | medium   | A bare except also catches SystemExit and KeyboardInterrupt, hiding shutdowns and bugs.                                                     |
| <a id="python-swallowed-exception"></a>[`python-swallowed-exception`](docs/rules/python-swallowed-exception.md)                               | medium   | A Python except block only passes, so the failure is dropped silently.                                                                      |
| <a id="query-runner-not-released"></a>[`query-runner-not-released`](docs/rules/query-runner-not-released.md)                                  | critical | A TypeORM QueryRunner is not released in a finally block, so an error leaks its pooled connection.                                          |
| <a id="react-async-effect-callback"></a>[`react-async-effect-callback`](docs/rules/react-async-effect-callback.md)                            | medium   | An async function is passed to useEffect, so its promise is treated as the cleanup function and its errors go unhandled.                    |
| <a id="react-effect-sets-state-every-render"></a>[`react-effect-sets-state-every-render`](docs/rules/react-effect-sets-state-every-render.md) | high     | An effect with no dependency array sets state to a new value on every run, so the component re-renders forever.                             |
| <a id="react-list-missing-key"></a>[`react-list-missing-key`](docs/rules/react-list-missing-key.md)                                           | medium   | An element or fragment returned from .map() has no key prop, so React cannot track items when the list changes.                             |
| <a id="react-state-mutated-in-place"></a>[`react-state-mutated-in-place`](docs/rules/react-state-mutated-in-place.md)                         | high     | A useState value is mutated in place and passed to its own setter, so React sees the same reference and skips the re-render.                |
| <a id="redis-incr-then-expire"></a>[`redis-incr-then-expire`](docs/rules/redis-incr-then-expire.md)                                           | medium   | A Redis counter increment and its expire on the same key are two round trips and not atomic.                                                |
| <a id="request-number-unvalidated"></a>[`request-number-unvalidated`](docs/rules/request-number-unvalidated.md)                               | medium   | A number parsed from request input reaches a query or calculation with no NaN or range check.                                               |
| <a id="retry-without-backoff"></a>[`retry-without-backoff`](docs/rules/retry-without-backoff.md)                                              | medium   | A retry loop calls the network again with no delay between attempts.                                                                        |
| <a id="return-in-finally"></a>[`return-in-finally`](docs/rules/return-in-finally.md)                                                          | high     | Returning from finally can replace a pending return value or suppress a thrown error.                                                       |
| <a id="return-newline"></a>[`return-newline`](docs/rules/return-newline.md)                                                                   | high     | A line break after return ends the statement before the apparent return value.                                                              |
| <a id="rust-unwrap-in-production"></a>[`rust-unwrap-in-production`](docs/rules/rust-unwrap-in-production.md)                                  | medium   | Rust code outside tests calls unwrap(), turning an Err or None into a panic.                                                                |
| <a id="sql-insert-truncated-at-semicolon"></a>[`sql-insert-truncated-at-semicolon`](docs/rules/sql-insert-truncated-at-semicolon.md)          | high     | A SQL dump parser ends INSERT values at a semicolon inside quoted text.                                                                     |
| <a id="stream-pipe-unhandled-error"></a>[`stream-pipe-unhandled-error`](docs/rules/stream-pipe-unhandled-error.md)                            | high     | A stream is piped with .pipe() and no error handling, so a stream error can crash the process or leak the file.                             |
| <a id="swallowed-error"></a>[`swallowed-error`](docs/rules/swallowed-error.md)                                                                | medium   | A catch block drops the error and the code after the try carries on as if it succeeded.                                                     |
| <a id="switch-not-exhaustive"></a>[`switch-not-exhaustive`](docs/rules/switch-not-exhaustive.md)                                              | medium   | A switch over a union or enum has no default and misses members, so the missing value leaves the result undefined.                          |
| <a id="throw-non-error"></a>[`throw-non-error`](docs/rules/throw-non-error.md)                                                                | medium   | A string, number or object literal is thrown instead of an Error, so there is no stack trace.                                               |
| <a id="typeorm-transaction-client-escape"></a>[`typeorm-transaction-client-escape`](docs/rules/typeorm-transaction-client-escape.md)          | critical | A write inside a TypeORM transaction goes through a repository not bound to it.                                                             |
| <a id="unbounded-promise-all"></a>[`unbounded-promise-all`](docs/rules/unbounded-promise-all.md)                                              | high     | Promise.all runs over an unbounded collection without a concurrency limit, risking memory spikes or downstream saturation.                  |
| <a id="uncaught-exception-continues"></a>[`uncaught-exception-continues`](docs/rules/uncaught-exception-continues.md)                         | high     | An uncaughtException handler neither exits nor rethrows, so the process keeps running in an undefined state.                                |
| <a id="unguarded-boundary-access"></a>[`unguarded-boundary-access`](docs/rules/unguarded-boundary-access.md)                                  | medium   | A nested property is read from outside input or a lookup that can be missing, so absent data throws a TypeError.                            |
| <a id="unreachable-code"></a>[`unreachable-code`](docs/rules/unreachable-code.md)                                                             | medium   | Statements follow a return, throw, break or continue in the same block and never run.                                                       |
| <a id="upload-without-size-limit"></a>[`upload-without-size-limit`](docs/rules/upload-without-size-limit.md)                                  | high     | A multer or Nest upload interceptor has no file size limit.                                                                                 |
| <a id="webhook-missing-idempotency-check"></a>[`webhook-missing-idempotency-check`](docs/rules/webhook-missing-idempotency-check.md)          | medium   | A webhook route inserts rows without first checking whether the event was already processed.                                                |

<!-- loadwise:rules:end -->

## Migration safety

`npx loadwise rel migrations` reads Prisma, Drizzle, TypeORM, Knex and Sequelize migrations (SQL or code) and flags statements that lock or rewrite a table. It reads files only. `--dialect postgres|mysql` selects the rule set, `--json` for structured output and `--ignore RULE` to skip a rule. The older `loadwise perf migrations` and `loadwise perf contracts` still work and print a note pointing to `rel`.

<!-- loadwise:rules:start checker=reliability group=migration-safety -->

| Rule                                                                                                                                       | Impact   | What it flags                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------- |
| <a id="migration-breaking-drop"></a>[`migration-breaking-drop`](docs/rules/migration-breaking-drop.md)                                     | critical | A migration drops a column or table that running code may still use.                   |
| <a id="migration-breaking-rename"></a>[`migration-breaking-rename`](docs/rules/migration-breaking-rename.md)                               | high     | A migration renames a column or table that running code may still use.                 |
| <a id="migration-column-type-rewrite"></a>[`migration-column-type-rewrite`](docs/rules/migration-column-type-rewrite.md)                   | critical | A migration changes a column type in a way that rewrites the table.                    |
| <a id="migration-concurrent-in-transaction"></a>[`migration-concurrent-in-transaction`](docs/rules/migration-concurrent-in-transaction.md) | high     | A CONCURRENTLY index statement runs inside a transaction, where PostgreSQL rejects it. |
| <a id="migration-constraint-not-valid"></a>[`migration-constraint-not-valid`](docs/rules/migration-constraint-not-valid.md)                | high     | A constraint is added and validated in one step instead of NOT VALID first.            |
| <a id="migration-constraint-without-index"></a>[`migration-constraint-without-index`](docs/rules/migration-constraint-without-index.md)    | high     | A unique or primary key constraint builds its index while blocking writes.             |
| <a id="migration-index-not-concurrent"></a>[`migration-index-not-concurrent`](docs/rules/migration-index-not-concurrent.md)                | critical | A PostgreSQL index is built without CONCURRENTLY, blocking writes to the table.        |
| <a id="migration-missing-lock-timeout"></a>[`migration-missing-lock-timeout`](docs/rules/migration-missing-lock-timeout.md)                | high     | A migration statement takes a lock with no lock_timeout set.                           |
| <a id="migration-mysql-lock-unspecified"></a>[`migration-mysql-lock-unspecified`](docs/rules/migration-mysql-lock-unspecified.md)          | high     | A MySQL ALTER does not state its LOCK level.                                           |
| <a id="migration-mysql-table-copy"></a>[`migration-mysql-table-copy`](docs/rules/migration-mysql-table-copy.md)                            | critical | A MySQL ALTER copies the whole table.                                                  |
| <a id="migration-not-null-without-default"></a>[`migration-not-null-without-default`](docs/rules/migration-not-null-without-default.md)    | high     | A NOT NULL column is added without a default, which fails once rows exist.             |
| <a id="migration-set-not-null-scan"></a>[`migration-set-not-null-scan`](docs/rules/migration-set-not-null-scan.md)                         | high     | SET NOT NULL scans the whole table while holding a lock.                               |
| <a id="migration-table-rewrite-command"></a>[`migration-table-rewrite-command`](docs/rules/migration-table-rewrite-command.md)             | critical | A migration runs VACUUM FULL, CLUSTER or REINDEX, which rewrites or locks the table.   |
| <a id="migration-unparsed"></a>[`migration-unparsed`](docs/rules/migration-unparsed.md)                                                    | low      | A migration statement could not be parsed and needs a manual review.                   |
| <a id="migration-volatile-default"></a>[`migration-volatile-default`](docs/rules/migration-volatile-default.md)                            | high     | A column is added with a volatile default, which rewrites the table.                   |

<!-- loadwise:rules:end -->

Only new migrations fail the run. Older migrations are contextual: counted, listed with `--include-contextual`, and never exit 1.

**CI recipe.** Enforce only what the branch adds or changes (files modified since the merge base, plus untracked files). Use a full-history checkout (`fetch-depth: 0`) so the ref resolves.

```sh
npx loadwise rel migrations --changed-since origin/main
```

**Baseline workflow.** For a project with existing migrations, accept them once and enforce the rest.

```sh
npx loadwise rel migrations --write-baseline   # writes loadwise.migrations-baseline.json
npx loadwise rel migrations                    # new migrations fail; baselined ones do not
```

Commit the baseline. `--baseline FILE` reads or writes another path. Exit codes match the source checks: 0 passed, 1 findings in enforced migrations, 2 invalid input.

## API contract safety

`npx loadwise rel contracts [--changed-since REF] [--json]` compares the working tree with the merge base of `REF` (default `HEAD`) and flags changes that break API clients. `loadwise check --changed-since REF` includes the same findings in the performance report. Both commands respect workspace selection, ignored paths and rules, configured rule levels, and minimum impact. Visible breaking changes fail by default. Rules set to warn appear in the report and do not fail the check. Invalid input exits 2. Use a full-history checkout (`fetch-depth: 0`) so the ref resolves.

It compares three kinds of source:

- **OpenAPI and Swagger JSON** (`openapi.json`, `swagger.json`). YAML documents are skipped with a note, because no YAML parser ships with loadwise; commit or check a JSON export instead.
- **GraphQL SDL** (`*.graphql`, `*.gql`, for example the `schema.gql` a code-first server emits). Query documents are skipped.
- **NestJS classes** used as `@Body()` types or as controller return types (also `@ApiResponse({ type })`), found in `*.controller.ts` and read from the file that declares them (relative imports only). Only property names, `?`, `@IsOptional()` and the written type text are compared.

<!-- loadwise:rules:start checker=reliability group=api-contract-safety -->

| Rule                                                                                                | Impact   | What it flags                                                                                          |
| --------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| <a id="api-enum-value-removed"></a>[`api-enum-value-removed`](docs/rules/api-enum-value-removed.md) | high     | An enum value or string-literal option that clients could send was removed.                            |
| <a id="api-removed-field"></a>[`api-removed-field`](docs/rules/api-removed-field.md)                | high     | A response field, GraphQL type, field, argument or union member, or returned DTO property was removed. |
| <a id="api-removed-operation"></a>[`api-removed-operation`](docs/rules/api-removed-operation.md)    | critical | An OpenAPI operation or a GraphQL Query, Mutation or Subscription field was removed.                   |
| <a id="api-required-input"></a>[`api-required-input`](docs/rules/api-required-input.md)             | high     | A request field, parameter or GraphQL argument is new and required, or became required.                |
| <a id="api-type-changed"></a>[`api-type-changed`](docs/rules/api-type-changed.md)                   | high     | A field or parameter changed type, or a GraphQL type changed nullability in a breaking direction.      |

<!-- loadwise:rules:end -->

Removals point at the line in the old version (the message says so); every other finding points at the new line. A new version next to the old one (`/v2/users` added while `/v1/users` stays) breaks nothing and is not flagged. A removed request property is flagged only when the project builds a `ValidationPipe` with `forbidNonWhitelisted: true`, because only then do clients that still send it get a 400. Properties inherited from a base class in a relative import count as the class's own.

```sh
npx loadwise rel contracts --changed-since origin/main
npx loadwise check --changed-since origin/main
```

## Impact levels

The levels and the `--min-impact` flag work as described under the performance checker's impact levels. `loadwise rel` and the reliability section of `loadwise check` use the impact levels in the rule index.

# Maintainability checker

`loadwise maint` finds code that would benefit from a design review and enforces the architectural decisions a team has already made. Run it on a project folder with `npx loadwise maint .`, or `npx loadwise maint . --json` for structured output.

## What gets checked

<!-- loadwise:rules:start checker=maintainability group=what-gets-checked -->

| Rule                                                                                                                     | Impact | What it flags                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------- |
| <a id="data-access-boundary"></a>[`data-access-boundary`](docs/rules/data-access-boundary.md)                            | medium | A file outside the approved paths imports a configured database driver or ORM.                  |
| <a id="deep-control-flow"></a>[`deep-control-flow`](docs/rules/deep-control-flow.md)                                     | low    | Control structures are nested four levels deep.                                                 |
| <a id="dependency-cycle"></a>[`dependency-cycle`](docs/rules/dependency-cycle.md)                                        | high   | An eager chain of internal imports leads back to the module it started from.                    |
| <a id="deprecated-node-api"></a>[`deprecated-node-api`](docs/rules/deprecated-node-api.md)                               | medium | A deprecated Node.js API is used: new Buffer(), url.parse() or fs.exists().                     |
| <a id="double-type-assertion"></a>[`double-type-assertion`](docs/rules/double-type-assertion.md)                         | low    | A value is cast through unknown or any to a second type, bypassing the type checker.            |
| <a id="duplicate-implementation"></a>[`duplicate-implementation`](docs/rules/duplicate-implementation.md)                | medium | Substantial functions share the same implementation.                                            |
| <a id="file-placement"></a>[`file-placement`](docs/rules/file-placement.md)                                              | low    | A file with a configured suffix sits outside its allowed folders.                               |
| <a id="focused-test-committed"></a>[`focused-test-committed`](docs/rules/focused-test-committed.md)                      | medium | A committed .only, fit or fdescribe makes the test runner skip every other test.                |
| <a id="folder-boundary"></a>[`folder-boundary`](docs/rules/folder-boundary.md)                                           | medium | An import crosses a folder boundary the team declared.                                          |
| <a id="high-branch-complexity"></a>[`high-branch-complexity`](docs/rules/high-branch-complexity.md)                      | medium | A function reaches a branch complexity score of 15.                                             |
| <a id="large-class"></a>[`large-class`](docs/rules/large-class.md)                                                       | low    | A class has more than 30 methods, accessors, constructors or function-valued fields.            |
| <a id="large-module"></a>[`large-module`](docs/rules/large-module.md)                                                    | low    | A file has more than 600 lines of code.                                                         |
| <a id="long-parameter-list"></a>[`long-parameter-list`](docs/rules/long-parameter-list.md)                               | low    | A function takes more than 5 positional parameters.                                             |
| <a id="query-mutates-state"></a>[`query-mutates-state`](docs/rules/query-mutates-state.md)                               | medium | A method marked @maintainabilityQuery writes through this.                                      |
| <a id="stray-console"></a>[`stray-console`](docs/rules/stray-console.md)                                                 | low    | A console call in production code bypasses the logger, so its output has no level or structure. |
| <a id="ts-suppression-without-reason"></a>[`ts-suppression-without-reason`](docs/rules/ts-suppression-without-reason.md) | low    | A @ts-ignore, @ts-expect-error or @ts-nocheck directive has no explanation.                     |
| <a id="tsconfig-strict-disabled"></a>[`tsconfig-strict-disabled`](docs/rules/tsconfig-strict-disabled.md)                | medium | A tsconfig turns off strict type checking.                                                      |
| <a id="unreferenced-file"></a>[`unreferenced-file`](docs/rules/unreferenced-file.md)                                     | low    | A source file that nothing imports and that is not an entry point.                              |
| <a id="unused-export"></a>[`unused-export`](docs/rules/unused-export.md)                                                 | low    | An export that no scanned file imports.                                                         |
| <a id="unused-import"></a>[`unused-import`](docs/rules/unused-import.md)                                                 | low    | An imported name is never used in the file.                                                     |
| <a id="unused-local-variable"></a>[`unused-local-variable`](docs/rules/unused-local-variable.md)                         | low    | A local variable is assigned but never read.                                                    |

<!-- loadwise:rules:end -->

JS and TS source checks use the TypeScript parser. The optional ast-grep executable supplies native parsers for Python, Go, Java, C#, Rust, PHP, Ruby, Kotlin, C and C++. The nesting rule recognizes specific grammar constructs. Braceless forms and pattern-matching constructs have different coverage across languages. A `.h` file uses the C grammar. Use a C++ header extension for C++ grammar.

For any language, filename placement works directly on the inventory and module graphs can be supplied by a compiler, build system or dependency extractor. Direct import extraction is provided for JS/TS. It resolves project-local modules and TypeScript paths and ignores explicitly type-only imports. Unresolved aliases, compiler-specific metadata, runtime-generated imports, and some re-exports can change the actual runtime graph. JSON includes per-language parsed-file counts and the number of files eligible for automatic dependency analysis.

## Project rules

Save team decisions in the `maintainability` section of `loadwise.config.json` at the project root, or pass `--config path/to/policy.json`.

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

The rules with an automatic rewrite are `deep-control-flow`, `high-branch-complexity`, `duplicate-implementation` and `dependency-cycle`. Each rule page describes its rewrite.

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
npx loadwise maint . --graph modules.json --config policy.json
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

# Security checker

`loadwise sec` reports code paths where input or missing scope can expose data: runtime text composed into SQL and, when the project declares them, Prisma and Drizzle queries that do not prove their row scope. Findings are review prompts with a location, a rule ID, an impact level, a generic fix example and, where it is safe, a source-based fix.

## Run it

```sh
npx loadwise sec                      # tsconfig.json or jsconfig.json in the current folder
npx loadwise sec -p tsconfig.json --json
npx loadwise sec src/orders.ts        # explicit files
npx loadwise sec --staged             # only findings on staged lines
npx loadwise sec deps --online        # known-vulnerable packages in the lockfile
npx loadwise sec polyglot src/        # ast-grep rules for Python, Go, Java, C#, Rust
```

It accepts the source-check flags of `loadwise perf`, including `--format`, `--min-impact`, `--baseline`, `--write-baseline`, `--loadwise-config`, `--workspace`, `--policy`, `--json`, `--include-contextual`, `--ignore`, `--fail-on`, `--fix` with `--yes` or `--only` and `--no-comments` or `--no-format`, `--staged` and `--changed-since`. It uses the TypeScript 6 compiler: `--engine auto` (the default) and `--engine js` both run the JS engine, because the native engine finds less. `--engine native` (alias `--native`) runs the TypeScript 7 native compiler and prints a stderr note that cross-file taint through JavaScript constructor functions and rate-limit detection are reduced. Rules that need a package's types stay silent until the package is installed; rules that recognise a library by its import work without `node_modules`. Test, fixture, mock, example and story files are contextual: they are counted, and `--include-contextual` shows them with the reason `Test or example source.`. `--fail-on contract` enforces no security rule by default. `--fix --yes` leaves changes to ValidationPipe whitelisting for individual review because enabling it can strip undecorated DTO properties.

## Rules

<!-- loadwise:rules:start checker=security group=rules -->

| Rule                                                                                                                                 | Impact   | What it flags                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| <a id="angular-bypass-security-trust"></a>[`angular-bypass-security-trust`](docs/rules/angular-bypass-security-trust.md)             | high     | DomSanitizer.bypassSecurityTrust* is called on a dynamic value, which turns off Angular's built-in sanitization.                         |
| <a id="auth-route-without-rate-limit"></a>[`auth-route-without-rate-limit`](docs/rules/auth-route-without-rate-limit.md)             | medium   | A login, signup or password-reset route has no rate limiter.                                                                             |
| <a id="bcrypt-low-cost"></a>[`bcrypt-low-cost`](docs/rules/bcrypt-low-cost.md)                                                       | medium   | A bcrypt password hash uses a work factor below the recommended minimum.                                                                 |
| <a id="client-env-secret-exposed"></a>[`client-env-secret-exposed`](docs/rules/client-env-secret-exposed.md)                         | critical | A secret-named env variable is read under a browser prefix (NEXT_PUBLIC_, VITE_, REACT_APP_...), so the build ships it to every visitor. |
| <a id="code-injection"></a>[`code-injection`](docs/rules/code-injection.md)                                                          | critical | Request-controlled input becomes source code evaluated by the application.                                                               |
| <a id="command-injection"></a>[`command-injection`](docs/rules/command-injection.md)                                                 | critical | Request-controlled input reaches a shell command string.                                                                                 |
| <a id="committed-secret"></a>[`committed-secret`](docs/rules/committed-secret.md)                                                    | critical | A tracked file contains a value that appears to be a credential.                                                                         |
| <a id="compose-hardcoded-secret"></a>[`compose-hardcoded-secret`](docs/rules/compose-hardcoded-secret.md)                            | high     | A Docker Compose service supplies a secret as a literal environment value.                                                               |
| <a id="cookie-missing-security-flags"></a>[`cookie-missing-security-flags`](docs/rules/cookie-missing-security-flags.md)             | high     | A sensitive cookie is set without the expected security attributes.                                                                      |
| <a id="cors-credentials-any-origin"></a>[`cors-credentials-any-origin`](docs/rules/cors-credentials-any-origin.md)                   | high     | A credentialed CORS response allows arbitrary origins.                                                                                   |
| <a id="cors-origin-regex-unanchored"></a>[`cors-origin-regex-unanchored`](docs/rules/cors-origin-regex-unanchored.md)                | medium   | A CORS origin regex also accepts look-alike hosts.                                                                                       |
| <a id="database-error-in-response"></a>[`database-error-in-response`](docs/rules/database-error-in-response.md)                      | medium   | An HTTP response includes a raw database error message.                                                                                  |
| <a id="dockerfile-add-remote-url"></a>[`dockerfile-add-remote-url`](docs/rules/dockerfile-add-remote-url.md)                         | medium   | A Dockerfile ADD instruction retrieves a resource from a remote URL.                                                                     |
| <a id="dockerfile-runs-as-root"></a>[`dockerfile-runs-as-root`](docs/rules/dockerfile-runs-as-root.md)                               | medium   | The final image selects root or inherits an unverified base-image user.                                                                  |
| <a id="dockerfile-secret-in-build"></a>[`dockerfile-secret-in-build`](docs/rules/dockerfile-secret-in-build.md)                      | high     | A Dockerfile exposes a secret through a build argument or environment variable.                                                          |
| <a id="dockerfile-unpinned-base-image"></a>[`dockerfile-unpinned-base-image`](docs/rules/dockerfile-unpinned-base-image.md)          | low      | A Dockerfile uses a base image reference that can change between builds.                                                                 |
| <a id="dom-xss-sink"></a>[`dom-xss-sink`](docs/rules/dom-xss-sink.md)                                                                | high     | Untrusted or dynamic HTML reaches innerHTML, outerHTML, insertAdjacentHTML, document.write or createContextualFragment (DOM XSS).        |
| <a id="drizzle-scope-unverified"></a>[`drizzle-scope-unverified`](docs/rules/drizzle-scope-unverified.md)                            | high     | A Drizzle operation lacks the row scope required by the declared policy.                                                                 |
| <a id="drizzle-sql-raw-dynamic"></a>[`drizzle-sql-raw-dynamic`](docs/rules/drizzle-sql-raw-dynamic.md)                               | critical | A dynamic SQL fragment reaches Drizzle without parameter binding.                                                                        |
| <a id="error-stack-in-response"></a>[`error-stack-in-response`](docs/rules/error-stack-in-response.md)                               | medium   | An HTTP response includes an internal error stack.                                                                                       |
| <a id="express-cookie-auth-missing-csrf"></a>[`express-cookie-auth-missing-csrf`](docs/rules/express-cookie-auth-missing-csrf.md)    | high     | Cookie-based session or auth is paired with state-changing routes without CSRF protection or `sameSite: "strict"`.                       |
| <a id="express-missing-helmet"></a>[`express-missing-helmet`](docs/rules/express-missing-helmet.md)                                  | low      | The Express or NestJS server starts without helmet security headers middleware (contextual: a proxy may set them).                       |
| <a id="frontend-storage-secret-token"></a>[`frontend-storage-secret-token`](docs/rules/frontend-storage-secret-token.md)             | medium   | A token, JWT, password or API key is stored in localStorage or sessionStorage, readable by any script on the page.                       |
| <a id="graphql-batching-unbounded"></a>[`graphql-batching-unbounded`](docs/rules/graphql-batching-unbounded.md)                      | medium   | GraphQL query batching is enabled without a batch size, query depth, or cost/complexity limit.                                           |
| <a id="graphql-introspection-enabled"></a>[`graphql-introspection-enabled`](docs/rules/graphql-introspection-enabled.md)             | medium   | A GraphQL server explicitly enables schema introspection.                                                                                |
| <a id="graphql-query-depth-unbounded"></a>[`graphql-query-depth-unbounded`](docs/rules/graphql-query-depth-unbounded.md)             | medium   | A GraphQL server accepts queries of any depth.                                                                                           |
| <a id="hardcoded-secret"></a>[`hardcoded-secret`](docs/rules/hardcoded-secret.md)                                                    | critical | The source supplies a literal credential or cryptographic secret.                                                                        |
| <a id="insecure-cipher"></a>[`insecure-cipher`](docs/rules/insecure-cipher.md)                                                       | medium   | A cryptographic operation selects an insecure cipher or mode.                                                                            |
| <a id="insecure-random-for-secret"></a>[`insecure-random-for-secret`](docs/rules/insecure-random-for-secret.md)                      | high     | A sensitive token or secret uses a non-cryptographic random source.                                                                      |
| <a id="jsx-javascript-url"></a>[`jsx-javascript-url`](docs/rules/jsx-javascript-url.md)                                              | high     | In React 18 and older or Preact, a URL search parameter or location hash starts a JSX href, action or iframe src (javascript: XSS).      |
| <a id="jwt-decode-for-auth"></a>[`jwt-decode-for-auth`](docs/rules/jwt-decode-for-auth.md)                                           | high     | Authentication uses decoded JWT claims without verifying the token signature.                                                            |
| <a id="jwt-none-algorithm"></a>[`jwt-none-algorithm`](docs/rules/jwt-none-algorithm.md)                                              | critical | JWT signing or verification allows an unsigned token.                                                                                    |
| <a id="jwt-sign-without-expiry"></a>[`jwt-sign-without-expiry`](docs/rules/jwt-sign-without-expiry.md)                               | medium   | A signed JWT has no explicit expiration.                                                                                                 |
| <a id="jwt-verify-without-algorithms"></a>[`jwt-verify-without-algorithms`](docs/rules/jwt-verify-without-algorithms.md)             | high     | JWT verification does not restrict the accepted signing algorithms.                                                                      |
| <a id="jwt-weak-secret-literal"></a>[`jwt-weak-secret-literal`](docs/rules/jwt-weak-secret-literal.md)                               | high     | JWT signing or verification uses a short (< 32 chars) or weak literal secret susceptible to brute-force forgery.                         |
| <a id="knex-raw-dynamic-text"></a>[`knex-raw-dynamic-text`](docs/rules/knex-raw-dynamic-text.md)                                     | critical | A dynamic SQL fragment reaches Knex without parameter binding.                                                                           |
| <a id="mass-assignment"></a>[`mass-assignment`](docs/rules/mass-assignment.md)                                                       | high     | An unfiltered request body reaches a persistence operation.                                                                              |
| <a id="mysql-dynamic-query-text"></a>[`mysql-dynamic-query-text`](docs/rules/mysql-dynamic-query-text.md)                            | critical | Dynamic SQL text reaches a MySQL client without parameter binding.                                                                       |
| <a id="nest-validation-without-whitelist"></a>[`nest-validation-without-whitelist`](docs/rules/nest-validation-without-whitelist.md) | medium   | A NestJS ValidationPipe permits properties outside the validated DTO.                                                                    |
| <a id="next-image-any-remote-host"></a>[`next-image-any-remote-host`](docs/rules/next-image-any-remote-host.md)                      | medium   | A Next.js images.remotePatterns entry sets hostname '**', so the image optimizer fetches and serves any host (open proxy).               |
| <a id="nosql-operator-injection"></a>[`nosql-operator-injection`](docs/rules/nosql-operator-injection.md)                            | high     | Request data can introduce query operators into a NoSQL filter.                                                                          |
| <a id="open-redirect"></a>[`open-redirect`](docs/rules/open-redirect.md)                                                             | medium   | An HTTP redirect destination is controlled by request data.                                                                              |
| <a id="password-hash-in-response"></a>[`password-hash-in-response`](docs/rules/password-hash-in-response.md)                         | high     | A response returns a user record that still holds its password hash.                                                                     |
| <a id="path-traversal"></a>[`path-traversal`](docs/rules/path-traversal.md)                                                          | high     | Request data controls a filesystem path without a recognized containment check.                                                          |
| <a id="pg-dynamic-query-text"></a>[`pg-dynamic-query-text`](docs/rules/pg-dynamic-query-text.md)                                     | medium   | Dynamic SQL text reaches the PostgreSQL client without parameter binding.                                                                |
| <a id="plaintext-password-storage"></a>[`plaintext-password-storage`](docs/rules/plaintext-password-storage.md)                      | critical | A password is stored or written without being hashed.                                                                                    |
| <a id="postmessage-missing-origin-check"></a>[`postmessage-missing-origin-check`](docs/rules/postmessage-missing-origin-check.md)    | medium   | postMessage targets '*', or a window message listener reads event.data without checking origin or source.                                |
| <a id="prisma-raw-unsafe-dynamic"></a>[`prisma-raw-unsafe-dynamic`](docs/rules/prisma-raw-unsafe-dynamic.md)                         | critical | Dynamic SQL text reaches an unsafe Prisma raw-query method.                                                                              |
| <a id="prisma-scope-unverified"></a>[`prisma-scope-unverified`](docs/rules/prisma-scope-unverified.md)                               | high     | A Prisma operation lacks the row scope required by the declared policy.                                                                  |
| <a id="prototype-pollution"></a>[`prototype-pollution`](docs/rules/prototype-pollution.md)                                           | high     | Request data can supply keys to a write or merge that can modify an object prototype.                                                    |
| <a id="react-dangerously-set-inner-html"></a>[`react-dangerously-set-inner-html`](docs/rules/react-dangerously-set-inner-html.md)    | high     | dangerouslySetInnerHTML receives HTML that is not a constant or sanitized.                                                               |
| <a id="reflected-xss-response"></a>[`reflected-xss-response`](docs/rules/reflected-xss-response.md)                                  | low      | An HTML response reflects request data without recognized escaping.                                                                      |
| <a id="regex-catastrophic-backtracking"></a>[`regex-catastrophic-backtracking`](docs/rules/regex-catastrophic-backtracking.md)       | high     | A regular expression that can backtrack exponentially or in polynomial time runs on request input.                                       |
| <a id="regex-from-input"></a>[`regex-from-input`](docs/rules/regex-from-input.md)                                                    | medium   | Request input supplies a regular expression pattern without recognized escaping.                                                         |
| <a id="secret-compared-non-constant-time"></a>[`secret-compared-non-constant-time`](docs/rules/secret-compared-non-constant-time.md) | medium   | A secret is compared with an operation that can vary in timing with its contents.                                                        |
| <a id="secret-in-log"></a>[`secret-in-log`](docs/rules/secret-in-log.md)                                                             | high     | A log statement can expose a credential, token, or other secret.                                                                         |
| <a id="secret-in-url-query"></a>[`secret-in-url-query`](docs/rules/secret-in-url-query.md)                                           | medium   | A password, token or API key is passed in a URL query string.                                                                            |
| <a id="sequelize-dynamic-query-text"></a>[`sequelize-dynamic-query-text`](docs/rules/sequelize-dynamic-query-text.md)                | critical | Dynamic SQL text reaches Sequelize without parameter binding.                                                                            |
| <a id="server-action-missing-auth"></a>[`server-action-missing-auth`](docs/rules/server-action-missing-auth.md)                      | high     | An exported Next.js Server Action performs work without verifying authentication or session state.                                       |
| <a id="ssrf-redirect-bypass"></a>[`ssrf-redirect-bypass`](docs/rules/ssrf-redirect-bypass.md)                                        | high     | An outbound HTTP request with a dynamic URL does not disable redirects, allowing SSRF allowlist bypasses.                                |
| <a id="ssrf-request-url"></a>[`ssrf-request-url`](docs/rules/ssrf-request-url.md)                                                    | high     | Request data controls the destination of a server-side network request.                                                                  |
| <a id="storage-object-public-acl"></a>[`storage-object-public-acl`](docs/rules/storage-object-public-acl.md)                         | high     | A storage upload makes the object publicly readable.                                                                                     |
| <a id="template-autoescape-disabled"></a>[`template-autoescape-disabled`](docs/rules/template-autoescape-disabled.md)                | medium   | A template engine is configured to render values without HTML escaping.                                                                  |
| <a id="template-injection"></a>[`template-injection`](docs/rules/template-injection.md)                                              | critical | Request data is interpreted as template source rather than a template value.                                                             |
| <a id="tls-verification-disabled"></a>[`tls-verification-disabled`](docs/rules/tls-verification-disabled.md)                         | high     | A TLS client skips certificate or server hostname verification.                                                                          |
| <a id="typeorm-dynamic-query-text"></a>[`typeorm-dynamic-query-text`](docs/rules/typeorm-dynamic-query-text.md)                      | critical | A dynamic SQL fragment reaches TypeORM without parameter binding.                                                                        |
| <a id="upload-client-filename"></a>[`upload-client-filename`](docs/rules/upload-client-filename.md)                                  | medium   | A file upload is stored under the original name supplied by the client.                                                                  |
| <a id="vm-sandbox-escape"></a>[`vm-sandbox-escape`](docs/rules/vm-sandbox-escape.md)                                                 | critical | Node `vm` or `vm2` executes dynamic code or an untrusted context, risking sandbox escape and host RCE.                                   |
| <a id="vue-v-html-unsanitized"></a>[`vue-v-html-unsanitized`](docs/rules/vue-v-html-unsanitized.md)                                  | high     | A Vue render function binds unsanitized dynamic HTML to innerHTML.                                                                       |
| <a id="weak-password-hash"></a>[`weak-password-hash`](docs/rules/weak-password-hash.md)                                              | high     | A password is hashed with an algorithm unsuitable for password storage.                                                                  |
| <a id="xml-external-entities"></a>[`xml-external-entities`](docs/rules/xml-external-entities.md)                                     | medium   | An XML parser allows processing of external entities.                                                                                    |
| <a id="zip-slip-extraction"></a>[`zip-slip-extraction`](docs/rules/zip-slip-extraction.md)                                           | high     | An archive entry controls an extraction path without a recognized containment check.                                                     |

<!-- loadwise:rules:end -->

The SQL rules report text assembled from a runtime value. When a part of that text traces to request data the finding is default and names the source; when no part does, it is contextual, because the value is usually an internal schema or table name. Every injection rule other than the SQL rules reports only values traced to request data.

The first six rules read project files rather than TypeScript: `loadwise sec -p <tsconfig>` scans the project folder (not explicit source files) with `git ls-files`, so ignored files are skipped; outside a git repository it walks the folder and never opens `.env*` files. `.env.example`, `.env.sample` and `.env.template` are checked for token formats only. Placeholder values (`changeme`, `example`, `your-...`, `${...}`, test or dummy values) and default credentials for a local service are not reported or are contextual. Dockerfile checks follow multi-stage builds: only the final stage matters for `dockerfile-runs-as-root`.

These rules moved from the performance checker with the same ids, so existing `// loadwise-reviewed` comments and `--ignore` flags keep working; `loadwise perf --ignore` still accepts them.

Example: `pool.query('SELECT * FROM orders ORDER BY ' + req.query.sort)` reports `pg-dynamic-query-text`; `pool.query('SELECT * FROM orders WHERE id = $1', [id])` does not.

## Polyglot source checks

`npx loadwise sec polyglot src/` accepts directories or individual `.py`, `.go`, `.java`, `.cs` and `.rs` files. It uses the optional ast-grep native binary and its syntax-tree patterns. These are syntactic patterns without taint tracking, so each finding is a review prompt: confirm that untrusted input can reach the call. They are not `--ignore` rule ids of the TypeScript source checks. [ast-grep](https://ast-grep.github.io/)

<!-- loadwise:rules:start checker=security group=polyglot-source-checks -->

| Rule                                                                                                                           | Impact | What it flags                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------- |
| <a id="csharp-ef-from-sql-raw"></a>[`csharp-ef-from-sql-raw`](docs/rules/csharp-ef-from-sql-raw.md)                            | high   | FromSqlRaw or ExecuteSqlRaw receives a concatenated or interpolated string, risking SQL injection. |
| <a id="csharp-process-start"></a>[`csharp-process-start`](docs/rules/csharp-process-start.md)                                  | medium | Process.Start launches an external process and risks command injection with untrusted arguments.   |
| <a id="go-exec-command-shell"></a>[`go-exec-command-shell`](docs/rules/go-exec-command-shell.md)                               | high   | exec.Command invokes a shell, which risks command injection.                                       |
| <a id="go-sql-sprintf-injection"></a>[`go-sql-sprintf-injection`](docs/rules/go-sql-sprintf-injection.md)                      | high   | SQL text formatted with fmt.Sprintf risks SQL injection.                                           |
| <a id="java-runtime-exec"></a>[`java-runtime-exec`](docs/rules/java-runtime-exec.md)                                           | medium | Runtime.getRuntime().exec runs an OS command and risks command injection with untrusted arguments. |
| <a id="java-sql-string-concat"></a>[`java-sql-string-concat`](docs/rules/java-sql-string-concat.md)                            | high   | A SQL query built by string concatenation risks SQL injection.                                     |
| <a id="python-insecure-deserialization"></a>[`python-insecure-deserialization`](docs/rules/python-insecure-deserialization.md) | high   | pickle or marshal deserialization of untrusted data can execute arbitrary code.                    |
| <a id="python-subprocess-shell-true"></a>[`python-subprocess-shell-true`](docs/rules/python-subprocess-shell-true.md)          | high   | subprocess with shell=True or os.system passes input through a shell, risking command injection.   |
| <a id="python-unsafe-yaml-load"></a>[`python-unsafe-yaml-load`](docs/rules/python-unsafe-yaml-load.md)                         | high   | yaml.load without SafeLoader can construct arbitrary Python objects.                               |
| <a id="rust-command-shell"></a>[`rust-command-shell`](docs/rules/rust-command-shell.md)                                        | high   | Command::new("sh") or Command::new("bash") spawns a shell and risks command injection.             |
| <a id="rust-unsafe-raw-pointer-deref"></a>[`rust-unsafe-raw-pointer-deref`](docs/rules/rust-unsafe-raw-pointer-deref.md)       | medium | A raw pointer dereference in an unsafe block bypasses Rust memory safety guarantees.               |

<!-- loadwise:rules:end -->

## Dependency checks

`loadwise sec deps --online [directory]` reads `package-lock.json` (lockfile version 2 or 3), `pnpm-lock.yaml` or `yarn.lock` (version 1 or Berry) from the directory or the nearest parent that has one, and asks the [OSV database](https://osv.dev) (which includes the GitHub Advisory Database) about every pinned package version. It sends package names and versions and nothing else. Answers are cached for 24 hours in the `loadwise` folder of the OS cache directory. It takes `--format text|json` (or `--json`), `--include-contextual`, `--ignore` and `--fail-on`. A network failure exits 2 rather than passing.

The network is opt-in: `loadwise sec --online` and `loadwise check --online` add these findings to their security report, and without `--online` they print one note that dependency checks were skipped.

<!-- loadwise:rules:start checker=security group=dependency-checks -->

| Rule                                                                                                                        | Impact | What it flags                                                                  |
| --------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| <a id="dependency-known-vulnerability"></a>[`dependency-known-vulnerability`](docs/rules/dependency-known-vulnerability.md) | medium | A resolved dependency version is listed in a published vulnerability advisory. |

<!-- loadwise:rules:end -->

## Security impact levels

`--min-impact` sets the minimum level to report. Dependency findings use the advisory severity.

## Project-defined row scopes

Row-scope checks read `prismaScopes` and `drizzleScopes` from the `performance` section of `loadwise.config.json`, found the same way as for the performance checker (see [Project-defined access policy](#project-defined-access-policy)). Every other rule runs without a scope policy. Row-scope checks start when the project identifies the existing model or table, its scoped property, and the helper that supplies an authorized scalar. Columns such as `tenantId`, `organizationId` and `workspace_id` have no special meaning to the checker on their own. Database mappings can keep the original storage column name. [Prisma database mapping](https://www.prisma.io/docs/orm/prisma-schema/data-model/database-mapping) · [Drizzle schema declarations](https://orm.drizzle.team/docs/sql-schema-declaration)

Drizzle also supports configuring quoted properties such as `"org-id"` and accessing them with brackets. In Prisma's generated filters, `AND`, `OR` and `NOT` are logical operators. If a physical column uses one of these names, configure the Prisma property that maps to it.

`prismaScopes` maps each generated model to its own protected field and a named export from the project's trusted authorization module. With the supplied example, `db.invoice.findMany({ where: { organizationId: requireOrganization() } })` has the expected scope. Choose the names already used by the project. The scanner handles common reads, writes and upsert branches, and requires every alternative in an OR to preserve the scope. For dynamic or nested shapes it cannot establish, it emits `prisma-scope-unverified`. Proof requires strict null checks. With explicit source files and a policy, the CLI enables strict null checks for its analysis.

`drizzleScopes` names an exported table, its schema module, its scoped property and the trusted helper. For a direct executed query, `.where(eq(invoices.workspace_id, currentWorkspace()))` establishes the configured predicate in the example. Use the property exposed by the ORM. A project with `organizationId: text('org_id')` would configure `"field": "organizationId"`. Each table can use a different convention. A later `.where()` can replace the earlier condition. The rule checks the effective condition and can report `drizzle-scope-unverified` when a protected table appears in a recognized chain and scope, projection or write data needs review. Stored builders, prepared aliases, raw SQL and arbitrary helper-generated statements can fall outside this check.

The import boundary for database modules is a maintainability rule; configure it through the `dataAccess` field of the `maintainability` section in `loadwise.config.json`.

These checks assume the configured helper authenticates the caller and authorizes the returned scope. Middleware, injected or previously obtained clients, raw SQL, unrecognized query shapes and database row-level policies require separate verification. A clean run only describes the covered operations.

# Accessibility checker

`loadwise a11y` finds markup that people using screen readers, keyboards or zoom cannot use: images without alt text, unlabelled form controls, click handlers on non-interactive elements, invalid ARIA, a missing page language and similar. It reads JSX and inline Angular templates from the TypeScript program, and `.html`, `.htm`, `.vue` and `.svelte` files from the project folders, leaving out ignored folders, build output, minified and vendored files and the config's `ignore` paths. It shares the source check of `loadwise perf`, so project discovery, config, engines, baselines and fix flags are the same, and `loadwise check` type-checks the project once for all of them. A project with no frontend sources (no JSX, HTML, Vue or Svelte files and no frontend package in any `package.json`) is skipped by `loadwise check` with a note; `loadwise a11y` on it reports 0 findings.

```sh
npx loadwise a11y -p tsconfig.json    # JSX, Angular templates and the project's markup files
npx loadwise a11y src/index.html      # explicit markup files
npx loadwise a11y --staged            # only findings on staged lines
npx loadwise a11y --fix --only <id>   # apply one generated fix
```

`npx loadwise a11y --help` lists every flag. A `loadwise.config.json` `rules` or `overrides` entry for an accessibility rule applies here, and findings live in the `accessibility` section of the baseline file.

## Rules

<!-- loadwise:rules:start checker=accessibility group=rules -->

| Rule                                                                                                                        | Impact | What it flags                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| <a id="a11y-button-missing-type"></a>[`a11y-button-missing-type`](docs/rules/a11y-button-missing-type.md)                   | medium | A button inside a form has no type, so it submits the form even when it only meant to run a handler.                         |
| <a id="a11y-clickable-non-interactive"></a>[`a11y-clickable-non-interactive`](docs/rules/a11y-clickable-non-interactive.md) | high   | A click handler sits on a non-interactive element without a role and keyboard support, so keyboard users cannot activate it. |
| <a id="a11y-html-missing-lang"></a>[`a11y-html-missing-lang`](docs/rules/a11y-html-missing-lang.md)                         | medium | The html element has no lang attribute, so screen readers guess the pronunciation.                                           |
| <a id="a11y-iframe-missing-title"></a>[`a11y-iframe-missing-title`](docs/rules/a11y-iframe-missing-title.md)                | medium | An iframe has no title, so screen readers cannot say what it contains.                                                       |
| <a id="a11y-img-missing-alt"></a>[`a11y-img-missing-alt`](docs/rules/a11y-img-missing-alt.md)                               | high   | An image has no alt text, so screen readers announce its file name or nothing.                                               |
| <a id="a11y-invalid-aria"></a>[`a11y-invalid-aria`](docs/rules/a11y-invalid-aria.md)                                        | high   | An ARIA attribute or role is misspelled or invalid, so assistive technology ignores it.                                      |
| <a id="a11y-missing-form-label"></a>[`a11y-missing-form-label`](docs/rules/a11y-missing-form-label.md)                      | high   | A form control has no label, so screen readers announce it without its purpose.                                              |
| <a id="a11y-positive-tabindex"></a>[`a11y-positive-tabindex`](docs/rules/a11y-positive-tabindex.md)                         | medium | A positive tabindex reorders keyboard focus away from the visual order.                                                      |
| <a id="a11y-viewport-zoom-disabled"></a>[`a11y-viewport-zoom-disabled`](docs/rules/a11y-viewport-zoom-disabled.md)          | high   | The viewport meta tag disables zoom, so people with low vision cannot enlarge the page.                                      |

<!-- loadwise:rules:end -->

## Impact levels

The levels and the `--min-impact` flag work as described under the performance checker's impact levels. `loadwise a11y` and the accessibility section of `loadwise check` use the impact levels in the rule index.

# Developing locally

Use Node.js 22.13+ for the development tools and run `npm ci --include=optional`. Open this repository folder as a trusted workspace in VS Code or Cursor and enable the recommended Prettier extension. Saving a supported file formats it with the repository settings.

Run `npm run format` to format files, `npm run lint` for correctness checks, or `npm run check` to verify formatting, lint and tests together.

From this checkout, run `node bin/loadwise.js check --config scripts/self-scan/loadwise.config.json` to scan Loadwise itself; that config excludes vendored files, tests, examples, and benchmark workloads so they keep their intended behavior.

# License

Licensed under the [Apache License 2.0](LICENSE). Copyright © 2026 Ibrahim Hafez.
