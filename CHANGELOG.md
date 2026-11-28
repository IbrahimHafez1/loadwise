# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Language server** (`loadwise lsp --stdio`) for any editor with a Language Server Protocol client, such as Neovim, Helix, Zed, Sublime Text, Emacs and VS Code or VSCodium through a generic client; the README has setup snippets. It does everything the VS Code extension did: diagnostics linked to the rule documentation, hovers with the recommendation and the before and after code, **Apply fix**, **Dismiss** and `source.fixAll.loadwise` code actions, code lenses, rescans after saves and watched-file changes through the incremental `perf --watch` process, multi-root workspaces, and the `enabled`, `project`, `cli`, `severity` and `codeLens` settings.
- **Security findings in the editor**: the language server also runs `loadwise sec` (and `sec polyglot` when the folder has Python, Go, Java, C# or Rust), alongside performance, reliability, maintainability and accessibility.
- Dismissed findings are saved in `.loadwise/dismissed.json` at the workspace folder root, so they can be shared through version control; `loadwise.showDismissed` and `loadwise.restoreDismissed` bring them back.
- `react-component-defined-in-component` flags a component declared inside another component and rendered as an element. It is a new component type on every render, so React remounts its subtree and loses its state and DOM.
- `angular-ngfor-missing-trackby` flags an `*ngFor` with no `trackBy` in an inline `template` or a `templateUrl` HTML file, since a list replaced with new objects recreates every item's DOM. `@for` blocks already require `track` and are not checked.
- Reliability rules: `child-process-without-error-listener` (a spawned child process with no `error` listener crashes the parent when the spawn fails), `error-rethrown-without-cause`, `throw-non-error` and `error-logged-without-stack`.
- Performance rule `llm-call-without-max-tokens` reports OpenAI chat completions and responses calls that set no output token limit.
- `pool-created-per-request-or-item` now also covers `S3Client`, `OpenAI`, `Anthropic` and `Stripe` clients created per request or loop item.
- Reliability rules for React and Next.js bugs that break an app at runtime: `react-effect-sets-state-every-render`, `react-async-effect-callback`, `react-state-mutated-in-place`, `react-list-missing-key` and `next-server-env-in-client`. None has an automatic fix.

### Removed

- **Breaking:** `loadwise perf editor init` and `loadwise perf editor watch`, with the generated `.vscode/tasks.json` watcher task and its problem matcher. Anyone using `perf editor` should delete that task and run `loadwise lsp` from their editor instead; `loadwise perf editor` now exits with a message saying so.
- The unpublished VS Code extension under `editor/` and its VSIX packager; the language server replaces it. Its shared modules moved to `lib/editor/`.

### Fixed

- A monorepo package without a `tsconfig.json` or `jsconfig.json` is now checked by the performance, reliability and security checkers with the standalone defaults (ES2022, NodeNext), instead of being skipped with a note. A monorepo made only of such packages is checked too, `--workspace` can select them, and `loadwise fix` no longer refuses to run because of them.
- A package without a config that mixes JavaScript and TypeScript is now checked the same way, instead of skipping the performance, reliability and security checkers. A package whose TypeScript sits under a sub-folder's own `tsconfig.json` is still skipped with a note.
- The injection checks now see request data that reaches a sink through a spread argument, an aliased `eval` or `Function`, shell options held in a variable or spread, a filter or pipeline built in a local variable, a request object spread into a nested filter, `where(path, value)`, a nonliteral `$or` branch, a `string | RegExp` value, bracket notation (`['$regex']`, `text['search']`) and `||=`, `??=` or `&&=`.
- SQL checks no longer treat a project's own `map` or `fill` method, an array changed after its declaration, or a `this['field']` write as fixed text.
- Taint now follows a request object passed to a helper, fields after an object spread, later reassignments of a mutable object, renamed imports, the array argument of a `map` callback, `+=` on a URL and adjacent literal URL pieces; a shadowed `Number`, `parseInt` or `ParseIntPipe` and a negated character class no longer count as sanitizers, and an allowlist check must test the guarded value itself.
- A ReDoS check no longer flags fixed alternatives such as `(?:ab|ac)+`, and a huge literal `slice` end no longer counts as a length cap.
- The performance and security checks no longer skip a project's JavaScript when its `tsconfig.json` does not set `allowJs`. Loadwise now checks those files with the standalone defaults (ES2022, NodeNext) instead of only naming them in a note, so a JavaScript-heavy project no longer reports 0 findings. A `jsconfig.json` beside the `tsconfig.json`, or `"allowJs": true`, still checks them with the project's own settings.
- Injection checks now follow fields written after an object literal (`options.shell = true`, `filter.$where = ...`, `record.name = ...`), `pipeline.push(...)` stages, chained `eval` and options aliases, deeply spread shell options, a local `$or` branch, a spread in a `where` condition and a compound assignment used as the sink argument. A later `shell: false` spread, an argument that a literal spread places after the evaluated one, a reordered constant array and a computed write beside a `#private` field no longer produce findings.

### Added

- Maintainability rules: `focused-test-committed` (`.only`, `fit` and `fdescribe` in test files), `ts-suppression-without-reason` (`@ts-ignore`, `@ts-expect-error` and `@ts-nocheck` with no explanation), `double-type-assertion` (`as unknown as T` and `as any as T`) and `tsconfig-strict-disabled` (`"strict": false`, or `strictNullChecks` or `noImplicitAny` turned off without `strict`).
- `regex-catastrophic-backtracking` now finds polynomial backtracking between a repeat at the edge of a group or loop and a neighbouring repeat over the same characters, such as the trailing `\s*` of `(?:\w+\(\)\s*)+` followed by `\s*$`, or `^\s*` followed by an optional `(?:\w*\s*=>)?`.
- `regex-catastrophic-backtracking` no longer treats a fixed-length cut such as `text.slice(0, 254)` as safe for a pattern that backtracks exponentially; the cut still silences polynomial patterns, where a short input keeps the work small.
- `regex-catastrophic-backtracking` now finds a loop whose body can match one character overlapping the next repeat, such as `^(?:a\s*)+\w+$`, and a failing end inside a group, such as `^a*(?:a+$)`. A repeat under `{0}` no longer counts, and `substring(start, 254)` with a non-literal start no longer counts as a length cap.

## [0.5.1] - 2026-11-27

### Changed

- The GitHub Action's display name is now `Loadwise Check`, for its GitHub Marketplace listing. Workflows keep using `IbrahimHafez1/loadwise@v0`.

### Fixed

- `a11y-clickable-non-interactive` no longer slows to seconds on a template event handler with a long run of whitespace; the patterns that accept propagation-only and empty handlers now run in linear time.
- Stopping `loadwise perf --watch` (or any checker re-spawned with a larger heap) with SIGTERM, SIGINT or SIGHUP now also stops the re-spawned process instead of leaving it running.
- `loadwise --fix` now points to `loadwise fix --yes` and `loadwise fix --all` instead of printing a raw argument-parser error.
- `loadwise fix` in a folder without a `tsconfig.json` or `jsconfig.json` now says so and asks to run it from the project folder or add one, instead of "The Performance scan did not complete".

## [0.5.0] - 2026-11-27

Initial public open-source release of `loadwise` under the Apache-2.0 license.

### Added

- **Five checkers** (`loadwise check`, `loadwise perf`, `loadwise rel`, `loadwise maint`, `loadwise sec`, `loadwise a11y`) covering JS/TS source, SQL migrations, OpenAPI contracts, PostgreSQL/MongoDB query plans, OTLP traces, Dockerfiles, Compose files, and dependency advisories.
- **Native TypeScript 7 (`tsgo`) & TypeScript 6 compiler support** via `lib/performance/compiler.ts`, plus `libpg-query` SQL parsing and `@ast-grep/cli` polyglot checks (`loadwise perf polyglot`, `loadwise sec polyglot`).
- **Execution-context classifier & Taint 2.0** for sharper signal across request handlers, background jobs, CLI tools, and tests, alongside 12 new JS/TS rules and per-rule `options` in `loadwise.config.json`.
- **Autofix v2** (`loadwise fix`) with 24+ new autofixers, import coalescing, Layer-2 TypeScript typecheck verification (`--verify-types`), convergence loop, `--dry-run`, and `--rule` filtering.
- **Tooling & CI integrations:** SARIF 2.1.0 and GitHub workflow annotations (`action.yml`), VS Code task watcher (`loadwise perf editor init`), local MCP server (`loadwise agent mcp`), and Claude Code plugin.
- **Reliability checker** (`loadwise rel`, `rel` in `--only`, `--skip` and `"checkers"`): code that fails at runtime or under concurrency. `loadwise check` type-checks the project once for performance, reliability and security, and prints a `reliability` report between performance and maintainability (also in `--json`, SARIF and GitHub annotations).
- **Accessibility checker** (`loadwise a11y`, `a11y` in `--only`, `--skip` and `"checkers"`): reads JSX from the shared TypeScript pass and HTML files, Vue and Svelte components and Angular templates beside it. Rules: `a11y-img-missing-alt`, `a11y-button-missing-type` (fix marked for review), `a11y-clickable-non-interactive`, `a11y-invalid-aria`, `a11y-missing-form-label`, `a11y-html-missing-lang`, `a11y-iframe-missing-title`, `a11y-positive-tabindex` and `a11y-viewport-zoom-disabled`. `check` skips it with a note in projects without frontend sources.
- Reliability rules: `unguarded-boundary-access` (fix adds optional chaining, marked for review), `assignment-in-condition`, `nan-comparison` and `invalid-typeof-comparison` (both only in JavaScript the compiler does not check), `unreachable-code` (only when `allowUnreachableCode` is not `false`), `loop-index-past-length`, and the resource leaks `file-handle-not-closed`, `query-runner-not-released`, `browser-not-closed` (try/finally fixes marked for review) and `interval-not-cleared`.
- Reliability polyglot rules (`loadwise rel polyglot`): `python-bare-except`, `python-swallowed-exception`, `go-error-discarded`, `go-defer-before-error-check`, `java-resource-without-try`, `csharp-disposable-without-using` and `rust-unwrap-in-production`.
- Maintainability rules: `unused-import` and `unused-local-variable` (skipped when `noUnusedLocals` is on, since the compiler reports them; names starting with `_` are ignored), `stray-console` (server code only; converts to an existing logger, marked for review) and `deprecated-node-api` (`new Buffer()`, `url.parse()`, `fs.exists()`).
