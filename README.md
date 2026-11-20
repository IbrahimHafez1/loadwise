# maintainability-check

A local CLI for finding code that would benefit from a design review and for enforcing the architectural decisions a team has already made. It runs on Node.js 20 or later. It can run independently of `backend-perf-check`.

To see both checkers in VS Code or Cursor using the editor's built-in tasks, install `backend-perf-check` alongside this package. Run `npx backend-perf-check editor init` once per project, then open the trusted folder and allow automatic tasks once. The task starts when the folder opens. Completing a source scan from the terminal refreshes the running editor task using its configured rules. Commit the generated task to share it with teammates. Findings appear in Problems and underlined code shows suggestions and plain-text examples on hover.

```sh
npm install --save-dev --include=optional ./maintainability-check-0.2.0.tgz
npx maintainability-check .
npx maintainability-check . --json
```

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
npx maintainability-check . --graph modules.json --config maintainability.config.json
```

List each project-relative module once. Edges use one-based source coordinates. Set `"kind": "deferred"` for an edge that loads lazily. Graph mode operates entirely on the supplied inventory and edges.

## CI and design review

Source checks count lower-priority findings separately. Use `--include-contextual` to display them with a reason. The JSON field `contextualFindingCount` is the additional count in the default view and a subset of `findings` in the expanded view. `--fail-on all` applies to displayed findings. Explicit folder and query contracts always remain visible.

Context includes documented independent test oracles, before/after source snapshots with a corresponding live file, marked generated code, certain flat data mappings, and flat lists of optional literal messages selected by simple field checks. Two ordinary implementations still form a default duplicate finding even when an archive or test oracle also contains a copy. A Nest module cycle can receive context when every internal eager edge is used solely in an explicit module `forwardRef` callback. A cycle supplied through graph input has no such source evidence.

The default `--fail-on contract` exits 1 for a declared folder, data-access or query contract violation. Design advisories remain visible and exit 0 on their own. Use `--fail-on all` to fail on any finding. Invalid configurations, source parse failures and missing required parser binaries exit 2.

DRY candidates can represent intentional copies between isolated modules. Deep nesting can accurately reflect a protocol. Use the reported locations to decide whether extracting a function, changing a dependency or retaining the current implementation makes the next change easier. YAGNI, Tell Don't Ask, the Law of Demeter and CUPID depend on domain knowledge. Fluent call chains and unused extension points alone do not establish a violation. [CUPID and the properties of good code](https://dannorth.net/cupid-for-joyful-coding/)

## Developing locally

Use Node.js 20.19+ (20.x) or 22.12 and later for the development tools and run `npm ci --include=optional`. Open this repository folder as a trusted workspace in VS Code or Cursor and enable the recommended Prettier extension. Saving a supported file formats it with the repository settings.

Run `npm run format` to format files, `npm run lint` for correctness checks, or `npm run check` to verify formatting, lint and tests together.
