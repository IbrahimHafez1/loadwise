# Contributing to Loadwise

Thanks for your interest in contributing to Loadwise.

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

## Prerequisites

- **Node.js 22.13+** and **npm**
- Install dependencies including optional native packages (`@ast-grep/cli` and the `@typescript/typescript-*` native compiler binaries):

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
- Keep commits small and focused: one logical change per commit (a rule, a fix, a refactor, a docs update), with its tests in the same commit, and a [Conventional Commits](https://www.conventionalcommits.org/) message such as `fix(rel): ...` or `feat(a11y): ...`. Don't mix unrelated changes, formatting sweeps or dependency updates into a feature commit. Each commit should build and pass its tests.
- Do not commit built `.js` / `.cjs` artifacts or `.tgz` / `.vsix` archives (they are gitignored).

## Releasing (maintainers)

1. In a pull request, bump `version` in `package.json` and `plugin/.claude-plugin/plugin.json` and move the `[Unreleased]` notes in `CHANGELOG.md` under the new version.
2. After it merges, tag the merge commit `vX.Y.Z` and push the tag. The `release` workflow runs the full check and stages the npm publish through Trusted Publishing (no token).
3. Approve the staged version on npmjs.com with 2FA; only then does it go live. A `-` in the version (for example `v0.6.0-rc.1`) publishes under the `next` dist-tag instead of `latest`. Approve stages in version order and reject an older pending one, since approving it later would move the dist-tag back to the older version.
4. The workflow's GitHub release job waits up to two hours for the approval, then creates the GitHub release and, for a stable `v0.x` version, moves the `v0` Action tag. If it timed out, approve the version and re-run the failed job.
5. If the workflow fails after the stage step, settle the staged version on npmjs.com before re-running it. Re-staging the same version fails with `409 Conflict`, and the workflow's token cannot see or clear a pending stage. Approve it if the build was good, and the re-run skips straight to the GitHub release and `v0` tag, reusing a release that already exists; reject it to stage again from the re-run.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
