# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The performance and security checks no longer skip a project's JavaScript when its `tsconfig.json` does not set `allowJs`. Loadwise now checks those files with the standalone defaults (ES2022, NodeNext) instead of only naming them in a note, so a JavaScript-heavy project no longer reports 0 findings. A `jsconfig.json` beside the `tsconfig.json`, or `"allowJs": true`, still checks them with the project's own settings.

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
