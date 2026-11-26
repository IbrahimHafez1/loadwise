# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-11-26

Initial public open-source release of `loadwise` under the Apache-2.0 license.

### Added

- **Three integrated checkers** (`loadwise check`, `loadwise perf`, `loadwise maint`, `loadwise sec`) covering JS/TS source, SQL migrations, OpenAPI contracts, PostgreSQL/MongoDB query plans, OTLP traces, Dockerfiles, Compose files, and dependency advisories.
- **Native TypeScript 7 (`tsgo`) & TypeScript 6 compiler support** via `lib/performance/compiler.ts`, plus `libpg-query` SQL parsing and `@ast-grep/cli` polyglot checks (`loadwise perf polyglot`, `loadwise sec polyglot`).
- **Execution-context classifier & Taint 2.0** for sharper signal across request handlers, background jobs, CLI tools, and tests, alongside 12 new JS/TS rules and per-rule `options` in `loadwise.config.json`.
- **Autofix v2** (`loadwise fix`) with 24+ new autofixers, import coalescing, Layer-2 TypeScript typecheck verification (`--verify-types`), convergence loop, `--dry-run`, and `--rule` filtering.
- **Tooling & CI integrations:** SARIF 2.1.0 and GitHub workflow annotations (`action.yml`), VS Code / Cursor editor extension & task watcher, local MCP server (`loadwise agent mcp`), and Claude Code plugin.
