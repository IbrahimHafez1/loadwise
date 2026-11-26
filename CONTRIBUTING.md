# Contributing to Loadwise

Thanks for your interest in contributing to Loadwise.

## Prerequisites

- **Node.js 22.12+** and **npm**
- Install dependencies including optional native packages (`@ast-grep/cli` and `@typescript/native-preview` binaries):

```sh
npm ci --include=optional
```

## Development Loop

Build the TypeScript sources (`npm run build` emits `.js` / `.cjs` files next to `.ts` / `.cts` sources) and run targeted tests while iterating:

```sh
npm run build
node --import ./test/manual-session.js --test test/shared/fix-resilience.test.js
```

For editor extension tests:

```sh
node --import ./test/manual-session.js --test editor/test/*.test.cjs
```

## Before Opening a Pull Request

Run the full verification suite from the repository root:

```sh
npm run check
npm run bench:recall
```

`npm run check` runs Prettier format checks, `oxlint --deny-warnings`, `tsc -p tsconfig.json`, and the full Node test suite.

- Keep rules, autofixes, and `README.md` rule anchors / `--help` docs in sync (`test/shared/docs-sync.test.js` enforces this).
- Include focused positive and negative regression tests for any rule, parser, or autofix change.
- Do not commit built `.js` / `.cjs` artifacts or `.tgz` / `.vsix` archives (they are gitignored).

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
