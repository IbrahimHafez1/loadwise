# Codewarden — maintainability

A local CLI for finding code that would benefit from a design review and for enforcing the architectural decisions a team has already made. It runs on Node.js 22 or later. It can run independently of `@codewarden/backend` (Codewarden — backend).

Install it, then run it on a project folder. It reports findings with a stable `#id`, a rewrite where one is safe, and a `// warden-reviewed` comment to dismiss false positives.

```sh
npm install --save-dev --include=optional ./codewarden-maintainability-0.2.0.tgz
npx warden-maint .
npx warden-maint . --json
```

## Editor

Install `@codewarden/backend` alongside this package and run `npx warden-backend editor init` once per project. Open the trusted folder in VS Code or Cursor and allow automatic tasks once. Findings from both checkers appear in Problems, with suggestions and plain-text examples on hover, and a terminal scan refreshes the running task. Commit the generated task to share it. The optional editor extension adds **Apply fix** and **Dismiss** buttons, hover links and the same shortcuts on every OS (Ctrl+Alt+. apply, Ctrl+Alt+Shift+. apply all, Ctrl+Alt+, dismiss); see its README in `@codewarden/backend`.

## What gets checked

| Rule                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deep-control-flow`                    | Four nested control structures. JS/TS reports the deepest site in each function. The other parsers report threshold crossings in supported conditional and loop bodies. Independent function scopes start fresh.                                                                                                                                                                                                 |
| `high-branch-complexity`               | A JS/TS function reaches a score of 15. Start at one and count each conditional, loop, switch, catch or ternary. A flat switch contributes one decision.                                                                                                                                                                                                                                                         |
| `duplicate-implementation`             | Substantial functions share a verified implementation. The report groups matching sites so a reviewer can compare their contracts before introducing a shared abstraction. JS/TS compares syntax while preserving identifiers, literals and operations. Python, Go, Java, C# and Rust compare exact body text of named functions selected by the parser. This deliberately misses reformatted or renamed copies. |
| `dependency-cycle`                     | An eager internal dependency path returns to its starting module. One ordered example path is shown per strongly connected component. Deferred loads can still be checked against folder boundaries.                                                                                                                                                                                                             |
| `folder-boundary` and `file-placement` | An import crosses a boundary declared by the team, or a filename suffix occurs outside its allowed folders. Both policies are opt-in.                                                                                                                                                                                                                                                                            |
| `data-access-boundary`                 | A JS/TS file outside the approved paths imports a configured database driver or ORM module at runtime. Static imports, re-exports, `import x = require()`, literal dynamic imports and unshadowed `require()` calls are checked. The policy is opt-in via `dataAccess`.                                                                                                                                          |
| `query-mutates-state`                  | A JS/TS class instance method marked `/** @maintainabilityQuery */` writes directly through `this`. Assignments, increments, deletes and destructuring writes are covered. Mutations through aliases or arbitrary helper calls require review.                                                                                                                                                                   |

JS and TS source checks use the TypeScript parser. The optional ast-grep executable supplies native parsers for Python, Go, Java, C#, Rust, PHP, Ruby, Kotlin, C and C++. The nesting rule recognizes specific grammar constructs. Braceless forms and pattern-matching constructs have different coverage across languages. A `.h` file uses the C grammar. Use a C++ header extension for C++ grammar.

For any language, filename placement works directly on the inventory and module graphs can be supplied by a compiler, build system or dependency extractor. Direct import extraction is provided for JS/TS. It resolves project-local modules and TypeScript paths and ignores explicitly type-only imports. Unresolved aliases, compiler-specific metadata, runtime-generated imports, and some re-exports can change the actual runtime graph. JSON includes per-language parsed-file counts and the number of files eligible for automatic dependency analysis.

## Project rules

Save team decisions in `maintainability.config.json` at the project root, or pass `--config path/to/policy.json`.

```json
{
  "boundaries": [{ "from": "src/domain", "disallow": ["src/http"] }],
  "placement": [{ "suffix": "_adapter.py", "under": ["adapters", "integrations"] }],
  "dataAccess": { "modules": ["pg", "@prisma/client", "./src/generated"], "allowIn": ["src/data"] },
  "exclude": ["third_party/legacy"]
}
```

`dataAccess` restricts runtime imports of named packages, their subpaths, module aliases (`#models`, `@/db`) or project-local entry points (entries starting with `./`) to the project-relative directories or files in `allowIn`. Local entries match the resolved file, so `./store` and `./store/index.ts` are different targets. `import type`, `export type` and, outside `verbatimModuleSyntax` projects, all-inline-`type` specifier lists are erased and not reported. Both `modules` and `allowIn` are required and nonempty. Findings are contract violations and fail the default `--fail-on contract`. Resolution is syntactic per file, with no type checker, so an ambient `declare module` does not count as a local file.

Paths use project-relative directory or file names. Directory boundaries match complete segments. The longest matching filename suffix wins. With no configuration, each project keeps its own folder conventions. Discovery uses tracked and nonignored untracked Git files where available and a directory walk elsewhere. Dependency and build output directories and minified files are skipped. Use explicit exclusions for checked-in vendor code.

## Inline fixes

Findings with a safe rewrite carry it as `fix = { changes: [{ file, line, before, after }], note? }` in `--json` output, and the text output prints it as a diff.

```sh
npx warden-maint . --fix         # asks y/n/a/q for each fix; needs a terminal
npx warden-maint . --fix --yes   # applies every fix without asking
```

`--fix` is refused with `--json` or `--graph`, and `--yes` alone is refused. Without a terminal, `--fix` requires `--yes`. A fix applies only where the original lines still exist. One that an earlier fix made stale is skipped and reappears, rebuilt, on the next run. Review the diff and run your tests afterwards.

| Rule                       | Rewrite                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deep-control-flow`        | Lifts the deepest branch one level with a guard clause, a merged nested `if`, or by dropping an `else` after a branch that exits.                                                              |
| `high-branch-complexity`   | Removes decisions the score counts: merges nested `if`s, joins adjacent same-exit `if`s with `\|\|`, turns `x ? true : false` into `Boolean(x)`, and `if (!x) x = value` into `x \|\|= value`. |
| `duplicate-implementation` | Keeps one top-level function and makes each other copy delegate to it, adding an import where needed. Applied only when every name the copies use resolves to the same binding.                |
| `dependency-cycle`         | Turns an import whose names are used only as types into `import type`, which removes that edge from the runtime cycle.                                                                         |

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
npx warden-maint . --graph modules.json --config maintainability.config.json
```

List each project-relative module once. Edges use one-based source coordinates. Set `"kind": "deferred"` for an edge that loads lazily. Graph mode operates entirely on the supplied inventory and edges.

## CI and design review

Source checks count lower-priority findings separately. Use `--include-contextual` to display them with a reason. The JSON field `contextualFindingCount` is the additional count in the default view and a subset of `findings` in the expanded view. `--fail-on all` applies to displayed findings. Explicit folder and query contracts always remain visible.

Context includes documented independent test oracles, before/after source snapshots with a corresponding live file, marked generated code, certain flat data mappings, and flat lists of optional literal messages selected by simple field checks. Two ordinary implementations still form a default duplicate finding even when an archive or test oracle also contains a copy. A Nest module cycle can receive context when every internal eager edge is used solely in an explicit module `forwardRef` callback. A cycle supplied through graph input has no such source evidence.

The default `--fail-on contract` exits 1 for a declared folder, data-access or query contract violation. Design advisories remain visible and exit 0 on their own. Use `--fail-on all` to fail on any finding. Invalid configurations, source parse failures and missing required parser binaries exit 2.

DRY candidates can represent intentional copies between isolated modules. Deep nesting can accurately reflect a protocol. Use the reported locations to decide whether extracting a function, changing a dependency or retaining the current implementation makes the next change easier. YAGNI, Tell Don't Ask, the Law of Demeter and CUPID depend on domain knowledge. Fluent call chains and unused extension points alone do not establish a violation. [CUPID and the properties of good code](https://dannorth.net/cupid-for-joyful-coding/)

## Use with AI coding agents

Any agent that can run shell commands and read an instructions file can drive the checker.

```sh
npx warden-maint agent init [--mode ask|auto] [--hook block|warn|off]
```

This writes a short block between `<!-- warden-maint:agent:start -->` and `...:end -->` markers in `AGENTS.md` at the project root (created if missing, replaced in place on re-runs, other text untouched, and `@codewarden/backend`'s block can sit beside it). If `CLAUDE.md` does not already contain `@AGENTS.md`, that line is added once, or the file is created with it.

- `ask` (default): the agent shows a one-line summary per fix and waits for approval.
- `auto`: the agent applies fixes that carry no behaviour caveat. In both modes it asks before changing `duplicate-implementation` or `dependency-cycle` findings, which are design decisions.

Every finding in `--json` output has a stable `id` (also shown as `#id` in text output), `fixable`, and `fix` when a rewrite exists. The id hashes the rule, the file and the flagged line's text, so it survives edits above the finding.

```sh
npx warden-maint . --fix --only <id>[,<id>...] [--json]
```

`--only` applies exactly those fixes with no prompt and no terminal. `--json` prints `{ applied, alreadyApplied, failed }`. An id whose change an earlier id in the same run already made is reported in `alreadyApplied`; an unknown id, a finding without a fix or a stale fix is in `failed` and the exit code is 2.

To dismiss a false positive, put `// warden-reviewed <rule-id> -- <specific reason>` on the line above it. The finding becomes contextual with that reason. Only a real line comment counts, and declared contracts (`file-placement`, `folder-boundary`, `data-access-boundary`, `query-mutates-state`) cannot be dismissed this way.

## Changed lines and the git pre-commit hook

```sh
npx warden-maint --staged .
npx warden-maint --changed-since <git-ref> .
npx warden-maint agent init --hook block|warn|off
```

`--staged` reports only findings on lines added or changed in `git diff --cached`; `--changed-since <git-ref>` does the same for the working tree against that ref. A function-level finding (`high-branch-complexity`, `deep-control-flow`) is kept when a changed line falls anywhere inside its function. Text output is one block per finding (`path:line [rule-id #id] message`, then a `fix:` command when a rewrite exists and a `dismiss:` comment to paste above the line), ending with `N new finding(s) in changed lines.`. `--json` works too, with the same shape filtered. With no changed JS/TS files it prints nothing and exits 0 before TypeScript loads. In these modes `--fail-on` defaults to `all`, so the exit code is 1 whenever a finding remains.

Only the changed files are analysed, while imports still resolve through the whole project. When as many files changed as the full scan's parallel threshold (600), the full scan runs instead and its findings are filtered to the changed lines, so every rule applies. Otherwise rules that need every file are limited: `duplicate-implementation` is skipped and `dependency-cycle` only sees cycles made of changed files' imports. Boundary and placement rules still run. Analysis reads working-tree files, so a file with unstaged edits can report shifted lines.

`agent init --hook block|warn` writes a marked block into `.git/hooks/pre-commit` (the `core.hooksPath` directory, or `.husky/pre-commit` when `.husky/` exists). `block` stops the commit while findings remain; `warn` (the default for a bare `--hook`) only prints them. Re-running replaces only its own block, an existing hook's other content is kept, and `--hook off` removes the block. If `lefthook.yml` exists it is not edited; the command to add is printed instead. `git commit --no-verify` skips the hook.

## Developing locally

Use Node.js 22.12+ for the development tools and run `npm ci --include=optional`. Open this repository folder as a trusted workspace in VS Code or Cursor and enable the recommended Prettier extension. Saving a supported file formats it with the repository settings.

Run `npm run format` to format files, `npm run lint` for correctness checks, or `npm run check` to verify formatting, lint and tests together.

## License

Copyright © 2026 Ibrahim Hafez. All rights reserved. See LICENSE.
