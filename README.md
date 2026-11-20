# Loadwise

Loadwise checks a backend project before it ships. One CLI runs two checkers:

- **Performance** (`loadwise perf`): repeated database work, ORM and query integrity, blocking calls, collection complexity, migration safety, schema-aware indexes, OpenTelemetry traces, executed query plans and an optional read-only database inspection.
- **Maintainability** (`loadwise maint`): deep nesting, branch complexity, duplicate implementations, dependency cycles and the folder, placement and data-access rules a team declares.

Both report findings with a stable `#id`, a suggested change where one is safe, and a `// loadwise-reviewed <rule-id> -- <reason>` comment to dismiss a false positive. A security checker (`loadwise sec`) is reserved for a later release.

## Install

Use Node.js 22 or later. From your application directory:

```sh
npm i -D @loadwise/cli
npx loadwise
```

`npx loadwise` checks the current folder with every checker and prints one titled report per checker.

## Commands

| Command                                                              | What it does                                                                                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `loadwise` or `loadwise check [directory]`                           | Runs every checker on the directory (default: the current folder) and prints Performance, then Maintainability.                     |
| `loadwise check --only perf,maint`                                   | Runs only the listed checkers: a comma-separated list of `perf`, `maint` and `sec`, in any order.                                   |
| `loadwise check --skip maint`                                        | Runs every checker except the listed ones. `--only` and `--skip` cannot be combined.                                                |
| `loadwise perf [args...]`                                            | The full performance checker; `loadwise perf --help` lists its commands and flags. See [Performance checker](#performance-checker). |
| `loadwise maint [args...]`                                           | The full maintainability checker; `loadwise maint --help` lists its flags. See [Maintainability checker](#maintainability-checker). |
| `loadwise sec`                                                       | Reserved. Until security checks ship, it and `--only sec` print an error and exit 2.                                                |
| `loadwise agent init [--mode ask\|auto] [--hook [block\|warn\|off]]` | Writes instructions for AI coding agents and installs the git pre-commit hook.                                                      |

`check` accepts these flags and passes them to every selected checker:

- `--json` prints one object with a key per selected checker, `{ "performance": report, "maintainability": report }`. A checker that was skipped or could not run has `null`.
- `--include-contextual` also shows lower-priority findings, each with its reason.
- `--staged` or `--changed-since <git-ref>` reports only findings on changed lines.
- `--fail-on contract|all` sets the exit threshold. Without it the performance checker fails on any displayed finding and the maintainability checker on contract violations only.

The performance checker uses the directory's `tsconfig.json` or `jsconfig.json`; without one, `check` looks for workspace packages (`package.json` `workspaces`, `pnpm-workspace.yaml` or `lerna.json`) and checks each one's config in one report, grouped per package; `--workspace <name|path>` (repeatable) limits it to some packages. With neither, `check` skips it and prints a note. `check` never changes files: each report ends with a `Fix all:` command, such as `npx loadwise perf -p tsconfig.json --fix --only <ids>`, that applies its fixes.

Exit codes: **0** passed, **1** a checker met its exit threshold, **2** invalid input or configuration in any checker.

## Use with AI coding agents

Any agent that runs shell commands and reads an instructions file (Claude Code, Cursor, Codex, Copilot agent, Windsurf, Gemini CLI) can drive both checkers.

```sh
npx loadwise agent init               # ask mode: the agent waits for approval before changing code
npx loadwise agent init --mode auto   # auto mode: applies fixes without behaviour caveats, asks about the rest
```

`agent init` writes one marked block into `AGENTS.md` at the project root and adds one `@AGENTS.md` line to `CLAUDE.md`, creating either file if needed. Rerunning it replaces the block and leaves your other text alone; blocks written by earlier releases of either checker are replaced by the single loadwise block. The block tells the agent to run `npx loadwise --json` after changing code (or `--only perf` / `--only maint` for one checker), review each finding by id, apply fixes with `--fix --only <id>`, and report a table of what it did. In both modes the agent asks before changing `duplicate-implementation` or `dependency-cycle` findings, which are design decisions. The mode is one line in the block, so you can edit it later.

### Git pre-commit hook

```sh
npx loadwise agent init --hook block   # a commit with new findings fails
npx loadwise agent init --hook warn    # findings are printed, the commit goes through (also plain --hook)
npx loadwise agent init --hook off     # removes only this block
```

The hook runs `loadwise check --staged` from the project folder, so every tool that commits through git sees findings from both checkers on the staged lines. It writes a marked block into the hooks folder (honouring `core.hooksPath`) or into `.husky/pre-commit` when `.husky/` exists, appends to a hook you already have, and rerunning it replaces only its own block, including blocks written by earlier releases. With lefthook it edits nothing and prints the command to add. `git commit --no-verify` skips the hook.

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
| Schema-aware index checks | `loadwise perf --schema snap.json`       | No (snapshot)    |
| Live database inspection  | `loadwise perf db`                       | Yes, read-only   |
| Traces and executed plans | `traces trace.json`, `plan explain.json` | No               |

Text findings carry a stable `#id`, a **Fix** diff where one applies and, for loops and repeated spans, an **Impact:** line. Impact always says which side is measured and which is estimated.

```text
examples/slow.ts:7:48 [array-repeated-find #9ab891a8b8f7] Each item can rescan the lookup array with find(), so cost grows with items times rows. Build `const byKey = new Map()` once (first match wins) and call `byKey.get(key)`; keep the original key-equality semantics.
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

Use the same one-shot commands in CI. Exit **0** means no displayed finding met the fail threshold, **1** means at least one did and **2** means the check could not complete. Add `--json` for structured output.

Source checks summarize contextual findings separately. They include certain one-off blocking calls in CLI startup or unit tests and write advisories in test sources. Use `--include-contextual` to display every candidate and its reason. JSON includes `contextualFindingCount` when any remain after explicit rule exclusions. In the default view this count is additional to the displayed findings. In the expanded view these entries appear in `findings` with a `contextualReason`.

The default `--fail-on all` applies to the displayed findings. For a complete advisory report that only fails CI on a transaction-client or import contract violation, use `npx loadwise perf --include-contextual --fail-on contract`. The enforced contract rule is `pg-transaction-on-pool`.

| Input                                   | Command after `npx loadwise perf`                                  | Coverage                                                                            |
| --------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| JavaScript or TypeScript                | `-p tsconfig.json`, `--watch -p tsconfig.json` or `src/handler.ts` | Typed database calls, collection algorithms, connections and synchronous Node APIs. |
| Python, Go, Java, C#, Rust              | `polyglot src`                                                     | Five narrowly scoped source patterns powered by a Rust binary.                      |
| OTLP/JSON from any application language | `traces request.otlp.json --threshold 5`                           | Repeated SQL or NoSQL operations, duplicate lookups and Redis/Valkey commands.      |
| Executed PostgreSQL or MongoDB plan     | `plan explain.json`                                                | Inefficient scans, disk sorts and deep pagination at individual plan stages.        |

## Source checks

Run in the directory containing `tsconfig.json` or `jsconfig.json`, pass `-p path/to/config.json`, or give explicit JS/TS files. A project check scans the config's input files and follows project references. Declaration files supply types. A standalone file check uses ES2022 and NodeNext compiler defaults. Use a project config for aliases, custom libraries and JS projects with `allowJs`.

| JS/TS rule                                                                                                           | Trigger and review                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg-query-in-loop`, `prisma-query-in-loop`                                                                           | Per-item queries. Consider a parameterized set query, relation load or bulk write if ordering and transaction behavior permit it. Prisma can already batch compatible `findUnique` calls.                        |
| `pg-count-materialization`, `prisma-count-materialization`                                                           | Counting an immediately loaded result. Use a database count with equivalent predicates and handle its return type.                                                                                               |
| `pg-first-materialization`, `prisma-first-materialization`                                                           | Reading only index zero from an unbounded result. Preserve ordering and empty-result behavior when limiting the query.                                                                                           |
| `pg-filter-materialization`, `prisma-filter-materialization`                                                         | Applying a literal equality filter in JS after loading an unbounded result. Check database collation and null semantics before moving the predicate.                                                             |
| `pg-top-k-materialization`, `prisma-top-k-materialization`                                                           | Sorting an unbounded result with a numeric comparator to keep the top rows. Use database ordering and a limit with a stable tie-breaker.                                                                         |
| `array-repeated-membership`, `array-repeated-find`, `rebuild-lookup-in-loop`                                         | Repeated linear lookups or rebuilt indexes. Reuse a Set or Map if inputs are stable and enough lookups justify construction. Preserve first-match semantics with duplicate keys.                                 |
| `reduce-copy-accumulator`, `loop-copy-accumulator`, `filter-for-existence`                                           | Copying a growing result or allocating a filtered array for a boolean test. Consider a private accumulator or a short-circuiting predicate.                                                                      |
| `pool-created-per-request-or-item`, `pg-unreleased-checkout`                                                         | A recognized pg, Prisma, MongoDB or Redis client/pool is created on a repeated path, or a chained pg checkout loses the client reference. Scope reuse to the right credentials and release checked-out clients.  |
| `node-sync-fs-in-async`, `node-sync-compression-in-async`, `node-sync-crypto-in-async`, `node-sync-process-in-async` | A recognized synchronous API blocks an async function. Examples include `readFileSync`, `gzipSync`, `scryptSync` and `execFileSync`.                                                                             |
| `redis-command-in-loop`                                                                                              | A per-key Redis or Valkey command on a repeated path. Use a multi-key command or a bounded pipeline if cluster slots, ordering and error handling permit it. SCAN cursor loops are skipped.                      |
| `password-hash-sync-in-async`                                                                                        | `hashSync`, `compareSync` or `genSaltSync` from bcrypt or bcryptjs in an async function blocks the event loop for the whole hash. Use the promise form.                                                          |
| `serial-awaits-in-literal`                                                                                           | An array or object literal awaits two or more values one after another, so it takes the sum of the waits. Use `Promise.all` unless a later call needs the side effects of an earlier one.                        |
| `queue-add-in-loop`                                                                                                  | `queue.add` on a recognized job queue runs once per item, one Redis round trip each. Collect the jobs and call `addBulk`, unless a later job needs the earlier job's result or id.                               |
| `redis-keys-command`                                                                                                 | `keys()` on a recognized ioredis or node-redis client blocks Redis while it scans the keyspace. Iterate with `SCAN` (`scanStream` or `scanIterator`) and account for duplicates and changing keys.               |
| `service-query-in-loop`                                                                                              | A call in a loop reaches several database operations through a project function, so the loop pays round trips for every item. Add a batch variant. Test, seed, benchmark and script sources get a softer note.   |
| `http-call-without-timeout`                                                                                          | A `fetch` or axios call has no `signal` or `timeout`, so a hung upstream holds the request. Set a timeout or an abort signal.                                                                                    |
| `upload-without-size-limit`                                                                                          | A multer or Nest upload interceptor has no `limits.fileSize`, so one large upload can exhaust memory. A global `MulterModule.register({ limits })` set elsewhere is not visible to the check.                    |
| `password-hash-pure-js`                                                                                              | `bcryptjs` hashes in pure JavaScript and costs tens to hundreds of milliseconds of main-thread CPU per call. Use native `bcrypt`, `@node-rs/bcrypt` or `argon2`. Reported once per file; test files are skipped. |
| `external-call-in-transaction`                                                                                       | An external call is awaited inside a database transaction callback, holding the connection and locks until it returns. Move it before the transaction or after commit; side effects cannot roll back.            |

Source diagnostics include a one-based line and column. Repeat `--ignore RULE` to omit specific JS/TS rules from a run. Keep your project's own type check in CI.

For an intentionally repeated operation, attach the review to that specific site. The comment must be on its own line immediately before the diagnostic line, name one exact rule and include a reason.

```ts
// loadwise-reviewed pg-query-in-loop -- Each iteration measures a separate query-plan sample.
await client.query(statement);
```

The site remains available with `--include-contextual`. Source comments cannot lower either CI contract, a configured row-scope check, a Prisma transaction-client escape or a Prisma read-modify-write finding. Test, seed and script context applies to Prisma dependent writes and Drizzle whole-table writes in test sources. It also applies to per-item query rules, index rules, serial awaits in literals, Redis `KEYS` and pure-JavaScript password hashing in test, seed and operator-tooling sources (`scripts`, `seeds`, `prisma/seed.ts`, `*.seed.ts`, deployment, migrations). Application code, tests and scripts still participate in source analysis.

Watch mode uses TypeScript 6.0.3. Watch a single project while editing. With `--watch --json`, each completed scan writes one JSON line. Ctrl+C stops the watcher. One-shot runs support project references.

One-shot checks pick the compiler automatically. On Node.js 22.13+ with the optional native package for your platform, they use Microsoft's Go-based TypeScript 7.1 beta compiler. It is 2-4 times faster on large projects and reports the same findings. If TypeScript 7 rejects the project configuration, for example `baseUrl` or `moduleResolution: "node10"`, the check uses TypeScript 6.0.3 and prints one note on stderr. `--engine native` (alias `--native`) requires TypeScript 7 and reports incompatible configuration as exit 2. `--engine js` always uses TypeScript 6.0.3. [TypeScript native compiler](https://github.com/microsoft/typescript-go)

Install the application's driver declarations and generate its Prisma client before checking. Result-shape checks target simple literal PostgreSQL reads and supported Prisma model delegates. Unresolved types, wrappers and deferred callbacks can hide findings. Repeated calls can be intentional, for example retries and ordered writes.

## ORM and query integrity checks

The JS/TS checker resolves declarations from installed drivers and generated clients. Install the dependencies used by the project, including type declarations. When resolution is incomplete, some calls will be missed. The rules run locally against source and recorded evidence.

| Library         | Source patterns covered                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prisma          | Executed per-item operations, fetching rows only to count, filter, sort or take the first, dependent creates, transaction client use, stale numeric overwrites and opt-in row scopes. |
| Drizzle ORM     | Executed fluent queries on the PostgreSQL, MySQL and SQLite core APIs, per-item prepared executions, and direct mutations with an absent or demonstrably ineffective predicate.       |
| TypeORM         | Repository reads inside repeated execution and simple `find` or `findBy` calls that load entities only for their count.                                                               |
| Sequelize       | Model reads inside repeated execution and immediate counts of simple `findAll` results.                                                                                               |
| Mongoose        | Consumed model queries including common `lean` and `exec` chains, plus immediate counts for simple equivalent filters.                                                                |
| Knex and Kysely | Consumed Knex builders and Kysely SELECT execution methods inside repeated work. Simple single-table queries materialized only to read their length.                                  |
| node-postgres   | Per-item queries, client-side result processing, pool handoff, transaction commands issued through a pool, and runtime fragments composed directly into SQL text.                     |

`orm-query-in-loop`, `drizzle-query-in-loop` and `orm-count-materialization` preserve the distinction between building a lazy statement and executing it. Counts with pagination, grouping, joins, hooks or scopes need particular care. TypeORM checks also identify entity reads used only for existence (`typeorm-existence-materialization`), unused wide columns in a direct DTO projection (`typeorm-wide-projection`), and a loop calling a local private helper that starts a transaction (`typeorm-transaction-in-loop`). Before changing a projection or an existence check, verify entity-load side effects. For per-row transactions, check rollback, ordering and error reporting before batching. The adapters recognize specific typed APIs. Custom methods with the same name, raw queries and wrappers often have different semantics.

| Integrity rule                      | What to review                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg-transaction-on-pool`            | A standalone transaction-control statement is sent to a typed pool. Use the same checked-out client for the whole transaction and release it in `finally`.                                                                                                                                                                                                                                                                                  |
| `pg-dynamic-query-text`             | Runtime fragments enter SQL text directly. Bind data as parameters and verify how any dynamic identifiers are chosen and quoted. A finding is a code-review prompt.                                                                                                                                                                                                                                                                         |
| `prisma-transaction-client-escape`  | A direct model operation uses the same outer client that opened an interactive transaction. Verify that the operation belongs inside that transaction.                                                                                                                                                                                                                                                                                      |
| `typeorm-transaction-client-escape` | An awaited write inside a TypeORM transaction goes through a repository or manager that is not bound to it, so it autocommits on another pooled connection, is not rolled back with the transaction and can block on its locks. Use the transaction's manager (`manager.getRepository(Entity)`).                                                                                                                                            |
| `prisma-dependent-writes`           | Adjacent creates pass a value from the first record into the next write. Explicit single-key nested `connect` can use a custom unique field when generated types confirm a relation. Direct scalar assignments currently recognize `parent.id` going into a field ending in `Id` or `_id`. Other scalar foreign-key conventions can be missed. If both writes must succeed together, consider a nested write or an appropriate transaction. |
| `prisma-read-modify-write`          | A direct read of one row feeds a numeric update of the same field and key. Review atomic arithmetic, an optimistic version check or serializable execution with retries.                                                                                                                                                                                                                                                                    |
| `prisma-distinct-in-memory`         | `findMany({ distinct })` reads every matching row and de-duplicates in Prisma's query engine, not with SQL `DISTINCT`. Use `groupBy` or a raw `SELECT DISTINCT`. Quiet when the `nativeDistinct` preview feature is enabled.                                                                                                                                                                                                                |
| `prisma-relation-count-in-list`     | A paged `findMany` selects `_count` of a relation, which Prisma computes over the whole related table. Fetch the page, then `groupBy` for the page ids and merge the counts.                                                                                                                                                                                                                                                                |
| `typeorm-load-then-save`            | A repository entity is loaded only to change a few fields and then `save()`d, costing a SELECT, an UPDATE and a transaction. Use `update()` or `increment()`; entity listeners and subscribers for update will not run.                                                                                                                                                                                                                     |
| `guard-query-per-request`           | A guard or similar per-request hook runs a database query before every handler. Cache the lookup with a short TTL and explicit invalidation, or carry the claims in the token.                                                                                                                                                                                                                                                              |
| `drizzle-unfiltered-write`          | An executed update/delete has no effective predicate in a recognized direct chain. An intentional whole-table maintenance operation can legitimately match.                                                                                                                                                                                                                                                                                 |

For Prisma, building an array of lazy queries alone is quiet. A sequential `await` inside a loop can trigger the rule. Same-tick `findUnique` callbacks can use Prisma's own batching, so these are left to runtime traces. [Prisma Client reference](https://www.prisma.io/docs/orm/reference/prisma-client-reference#prismapromise-behavior) · [Prisma transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions) · [node-postgres transactions](https://node-postgres.com/features/transactions) · [Drizzle conditional filters](https://orm.drizzle.team/docs/guides/conditional-filters-in-query)

### Project-defined access policy

Place `backend-perf.policy.json` beside the selected project config, or pass `--policy path/to/file.json`. Explicit source-file checks discover the policy in the working directory. A policy can use just the sections the project needs. Duplicate JSON keys within the same object produce a configuration error. [Example policy](examples/query-policy.json)

The performance and transaction rules run without any scope policy. Row-scope checks start when the project identifies the existing model or table, its scoped property, and the helper that supplies an authorized scalar. Columns such as `tenantId`, `organizationId` and `workspace_id` have no special meaning to the checker on their own. Database mappings can keep the original storage column name. [Prisma database mapping](https://www.prisma.io/docs/orm/prisma-schema/data-model/database-mapping) · [Drizzle schema declarations](https://orm.drizzle.team/docs/sql-schema-declaration)

Drizzle also supports configuring quoted properties such as `"org-id"` and accessing them with brackets. In Prisma's generated filters, `AND`, `OR` and `NOT` are logical operators. If a physical column uses one of these names, configure the Prisma property that maps to it.

`prismaScopes` maps each generated model to its own protected field and a named export from the project's trusted authorization module. With the supplied example, `db.invoice.findMany({ where: { organizationId: requireOrganization() } })` has the expected scope. Choose the names already used by the project. The scanner handles common reads, writes and upsert branches, and requires every alternative in an OR to preserve the scope. For dynamic or nested shapes it cannot establish, it emits `prisma-scope-unverified`. Proof requires strict null checks. With explicit source files and a policy, the CLI enables strict null checks for its analysis.

`drizzleScopes` names an exported table, its schema module, its scoped property and the trusted helper. For a direct executed query, `.where(eq(invoices.workspace_id, currentWorkspace()))` establishes the configured predicate in the example. Use the property exposed by the ORM. A project with `organizationId: text('org_id')` would configure `"field": "organizationId"`. Each table can use a different convention. A later `.where()` can replace the earlier condition. The rule checks the effective condition and can report `drizzle-scope-unverified` when a protected table appears in a recognized chain and scope, projection or write data needs review. Stored builders, prepared aliases, raw SQL and arbitrary helper-generated statements can fall outside this check.

The import boundary for database modules is a maintainability rule; configure it through the `dataAccess` section of `maintainability.config.json`.

These checks assume the configured helper authenticates the caller and authorizes the returned scope. Middleware, injected or previously obtained clients, raw SQL, unrecognized query shapes and database row-level policies require separate verification. A clean run only describes the covered operations.

### Async work and sorting

| Rule                              | When it reports                                                                                                                                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promise-combinator-serial-await` | A built-in `Promise.all` or `Promise.allSettled` receives an array of two or more already-awaited calls with known promise types. Starting them together changes which calls run after a failure. With `allSettled`, it also changes how rejections are returned.     |
| `known-reads-awaited-serially`    | Two adjacent awaited reads come from a project-configured `parallelReads` group and the second call is independent of the first result in a supported straight-line shape.                                                                                            |
| `numeric-sort-for-extreme`        | A numeric comparison sort on a private copy, or a nonmutating numeric sort, is used only to retrieve its first or last value. A single-pass extreme can use constant extra space. Preserve empty input, NaN, sparse inputs and signed-zero semantics when applicable. |
| `count-then-page-serial`          | A `count()` and a page query with the same filter run one after the other (TypeORM query builder or repository, Prisma). Use `getManyAndCount()` or `findAndCount()`, or start both Prisma calls together with `Promise.all` outside an interactive transaction.      |

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
npx loadwise perf -p tsconfig.json --fix --yes   # applies every fix without asking
```

`--fix` answers are **y**es, **n**o, **a**ll remaining and **q**uit. Without a terminal it requires `--yes`. `--fix` cannot be combined with `--watch`, or with `--json` except with `--only`, and `--yes` is valid only with `--fix`. A fix applies only where the original lines still exist, so code that changed since the scan is refused and a change already in the file is reported as already applied. A fix never overwrites an existing file. Review the diff and run your tests afterwards.

## Apply fixes by id

Every finding has a stable `id`, shown as `[rule-id #id]` in text output. It hashes the rule, the file and the flagged line's text, so it survives edits above the finding. JSON findings also carry `fixable` and, when available, `fix`. To apply chosen fixes without a prompt:

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

| Rule                                                                                                  | What it flags                                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `migration-index-not-concurrent`, `migration-concurrent-in-transaction`                               | A PostgreSQL index built without `CONCURRENTLY`, or `CONCURRENTLY` inside a transaction that cannot run it.                                 |
| `migration-not-null-without-default`, `migration-volatile-default`                                    | A NOT NULL column added without a default (fails once rows exist), or a volatile default that rewrites the table.                           |
| `migration-column-type-rewrite`, `migration-table-rewrite-command`                                    | A column type change or command (`VACUUM FULL`, `CLUSTER`, `REINDEX`) that rewrites the table.                                              |
| `migration-set-not-null-scan`, `migration-constraint-not-valid`, `migration-constraint-without-index` | Full-table validation scans, constraints that should be added `NOT VALID` first, and constraints that build an index while blocking writes. |
| `migration-breaking-drop`, `migration-breaking-rename`                                                | Dropping or renaming a column or table that running application code may still use.                                                         |
| `migration-missing-lock-timeout`                                                                      | A locking statement with no `lock_timeout`.                                                                                                 |
| `migration-mysql-table-copy`, `migration-mysql-lock-unspecified`                                      | MySQL changes that copy the table or leave the lock level unspecified.                                                                      |
| `migration-unparsed`                                                                                  | A statement the checker could not read. Review it by hand.                                                                                  |

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

## Schema-aware index checks

The source checker reads the project's ORM schema (Prisma, Drizzle, TypeORM, Sequelize, Mongoose) and compares declared indexes with the queries it finds.

| Rule                        | What it flags                                                                     |
| --------------------------- | --------------------------------------------------------------------------------- |
| `index-missing-filter`      | A query filters on a column that no index leads with.                             |
| `index-missing-order`       | A query orders by columns no index can serve in that order.                       |
| `index-missing-foreign-key` | A foreign key column has no index.                                                |
| `index-unusable-pattern`    | A predicate such as a leading-wildcard `LIKE` cannot use an ordinary index.       |
| `index-unusable-expression` | A function or expression on an indexed column prevents the index from being used. |

Pass `--schema snapshot.json` (written by `db --schema-snapshot`) to refine them with real table sizes and the measured round trip, which also feeds the Impact line of `*-query-in-loop` findings. Without a snapshot, the checks run from the source schema alone.

## Polyglot source checks

`npx loadwise perf polyglot src` accepts directories or individual `.py`, `.go`, `.java`, `.cs` and `.rs` files. It uses the optional ast-grep native binary and its syntax-tree patterns. Language-specific aliases and wrappers can fall outside a pattern. [ast-grep](https://ast-grep.github.io/)

| Rule                         | Example in a loop                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `python-copy-growing-list`   | A list initialized to `[]` is repeatedly assigned `items = items + [value]` in a simple loop. |
| `go-fixed-regexp-in-loop`    | `regexp.Compile("pattern")` or `regexp.MustCompile("pattern")`                                |
| `java-fixed-regex-in-loop`   | `Pattern.compile("pattern")`                                                                  |
| `csharp-fixed-regex-in-loop` | `new Regex("pattern")`                                                                        |
| `rust-fixed-regex-in-loop`   | `Regex::new("pattern")`                                                                       |

## Trace checks in other languages and databases

Supply a local **OTLP/JSON trace export** with `resourceSpans → scopeSpans → spans`. An OpenTelemetry Collector with a file export can produce this format. The CLI accepts one export object per invocation. For a collector output containing multiple JSON lines, pass the relevant export object for the request. Spans split across separate invocations count independently.

Try `npx loadwise perf traces node_modules/@loadwise/cli/examples/repeated-db.otlp.json`. The example reports five similar MongoDB operations under one parent. The trace rules use current and legacy database attributes and deduplicate span IDs.

| Rule                  | Evidence and interpretation                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repeated-db-span`    | Five similar sibling DB calls by default, grouped by resource, trace, parent and recorded database target. SQL statements, query summaries, operation/collection pairs and recognized DynamoDB `GetItem` events can provide signatures. Namespace-only MongoDB or DynamoDB groups call for inspection of the actual predicates.                                                                                                               |
| `redis-keys-scan`     | One Redis or Valkey `KEYS` command can scan the keyspace. For incremental iteration, account for duplicates and keys changing between `SCAN` calls.                                                                                                                                                                                                                                                                                           |
| `redis-repeated-read` | Repeated sibling `GET` or `HGET` calls. Consider compatible multi-key reads or bounded pipelining with appropriate cluster slots, ordering and error handling. Recognized pipeline children are excluded.                                                                                                                                                                                                                                     |
| `duplicate-key-read`  | Two or more reads with the same observable lookup, database target and recorded scalar context under one parent. The comparison accepts application-defined context keys. Supported evidence includes a concrete Redis `GET` key or a narrow SQL equality lookup with its bound parameter. Masked targets, ambiguous context, observed writes, transactions or failed calls suppress the suggestion where identity or freshness is uncertain. |

Matching keys in two reads are a reason to consider **request-local** reuse when authorization, freshness and ordering allow it. Keep existing telemetry redaction. A redacted key can still support a batching finding. Reports contain span IDs and counts and omit raw SQL, parameters and keys. Check `scannedSpans` and `eligibleDbSpans` when interpreting a clean result. Sampling, missing parents, different literal values and coarse summaries affect grouping. [OpenTelemetry database spans](https://opentelemetry.io/docs/specs/semconv/db/database-spans/) · [OTLP JSON encoding](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding)

## Executed query plans

Feed the CLI a JSON file from PostgreSQL `EXPLAIN (ANALYZE, FORMAT JSON)` or MongoDB `explain("executionStats")`. For example, run `npx loadwise perf plan node_modules/@loadwise/cli/examples/postgres-plan.json`. The checker reads the file locally. PostgreSQL's `ANALYZE` option executes the statement when you collect the plan. [PostgreSQL EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html) · [MongoDB explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)

| Observed work                                 | Threshold and review                                                                                                                                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg-sequential-scan`, `mongo-collection-scan` | At least 1,000 examined and at least 100 examined per returned record, treating zero returns as one for this ratio. Review selectivity and available indexes. PostgreSQL totals use the reported per-loop averages.                                   |
| `pg-disk-sort`, `mongo-disk-sort`             | At least 1,024 KiB of disk use by a PostgreSQL sort participant, including a reported incremental-sort group peak, or at least 1 MiB of spill or eight spills on a MongoDB sort. Check whether earlier filtering or an index can reduce sorting work. |
| `pg-deep-offset`, `mongo-deep-skip`           | At least ten times as many entries walked as returned and at least 10,000 skipped per execution. For sequential pages, keyset pagination needs a stable ordering with a unique tie-breaker.                                                           |

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

**Safety guarantees.** Statements go through a read-only gateway: sessions and transactions are read-only, with a 5 s statement timeout on PostgreSQL, and only SELECT, INSERT, UPDATE and DELETE can be explained. `EXPLAIN ANALYZE` runs only for a plain SELECT (a `WITH` that modifies data is refused). MongoDB uses a command allowlist. Error text is redacted: the connection URL, host, user, password and resolved IP addresses are replaced with `[redacted]`. Usage counters come from the node that answered, so an index unused here may still be used on a replica.

**`--measure` warning.** Building an index blocks writes to that table while it runs. Use it on staging only. It refuses a connection variable or database name matching `/prod/i`, a replica, an unknown table size and any table over 5,000,000 estimated rows, and it needs the long confirmation flag. When the HypoPG extension is installed, suggested indexes are also checked hypothetically without building anything.

**Measured vs estimated.** Output labels every figure. A _measured_ number was timed on your database (a round-trip median, or an `EXPLAIN ANALYZE` before and after an index built by `--measure`). An _estimated_ number comes from planner statistics or a model, and a suggestion validated only by HypoPG still says it is an estimate. Treat estimates as a reason to test, not as a result.

## Interpreting findings

Start with the endpoint's query count, latency and a representative input size. A reusable index or lookup table costs memory and build time. An extra database index also costs writes and storage. For a proposed batch or cache, compare results as well as time, including empty inputs, duplicates, tenant boundaries and concurrent writes.

The rules cover query shape, caching candidates, pooling, selected blocking work and collection complexity. Response compression settings, CDN placement, load balancing, partitioning, service boundaries and capacity planning depend on traffic, topology and operational costs. Use workload measurements when making those deployment decisions. [10 Essential Tips for Backend Performance Optimization](https://medium.com/@rhgustmfrh/10-essential-tips-for-backend-performance-optimization-8b55fce0ca17) · [Backend Performance Best Practices roadmap](https://roadmap.sh/backend-performance-best-practices)

## Verification and benchmarks

Integration checks used PostgreSQL 18.0 and MongoDB 8.2.3. Each engine examined 20,000 records for one match before an index was added. The corresponding indexed read passed. In both databases a deep page walked 15,010 entries to return ten, and the equivalent keyset query passed. Both engines also produced a disk-sort finding. MongoDB's live test used classic execution stages.

On Redis 7.2.16, the CLI flagged a real `KEYS` call and eight redacted `GET` calls. A test hook exposing only a synthetic key let it identify eight duplicate reads. A single request-local read returned the same eight values and passed. Python SQLite instrumentation separately verified nine statements versus one batched statement for the same eight result rows.

Use Node.js 22.13+ for the full development workflow, including the in-memory SQLite benchmark.

```sh
npm ci
npm test
node bin/loadwise.cjs perf -p examples
npm run bench:patterns
npm run bench:scan
npm run bench:scan -- --large
npm run bench:traces
```

The benchmark commands verify their expected results. The pattern benchmark compares equal application outputs. The scan benchmarks measure the checker itself. Real request latency depends on the workload, instrumentation and database.

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
npx loadwise maint . --fix         # asks y/n/a/q for each fix; needs a terminal
npx loadwise maint . --fix --yes   # applies every fix without asking
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
npx loadwise maint . --graph modules.json --config maintainability.config.json
```

List each project-relative module once. Edges use one-based source coordinates. Set `"kind": "deferred"` for an edge that loads lazily. Graph mode operates entirely on the supplied inventory and edges.

## CI and design review

Source checks count lower-priority findings separately. Use `--include-contextual` to display them with a reason. The JSON field `contextualFindingCount` is the additional count in the default view and a subset of `findings` in the expanded view. `--fail-on all` applies to displayed findings. Explicit folder and query contracts always remain visible.

Context includes documented independent test oracles, before/after source snapshots with a corresponding live file, marked generated code, certain flat data mappings, and flat lists of optional literal messages selected by simple field checks. Two ordinary implementations still form a default duplicate finding even when an archive or test oracle also contains a copy. A Nest module cycle can receive context when every internal eager edge is used solely in an explicit module `forwardRef` callback. A cycle supplied through graph input has no such source evidence.

The default `--fail-on contract` exits 1 for a declared folder, data-access or query contract violation. Design advisories remain visible and exit 0 on their own. Use `--fail-on all` to fail on any finding. Invalid configurations, source parse failures and missing required parser binaries exit 2.

DRY candidates can represent intentional copies between isolated modules. Deep nesting can accurately reflect a protocol. Use the reported locations to decide whether extracting a function, changing a dependency or retaining the current implementation makes the next change easier. YAGNI, Tell Don't Ask, the Law of Demeter and CUPID depend on domain knowledge. Fluent call chains and unused extension points alone do not establish a violation. [CUPID and the properties of good code](https://dannorth.net/cupid-for-joyful-coding/)

## Apply fixes by id

Every finding in `--json` output has a stable `id` (also shown as `#id` in text output), `fixable`, and `fix` when a rewrite exists. The id hashes the rule, the file and the flagged line's text, so it survives edits above the finding.

```sh
npx loadwise maint . --fix --only <id>[,<id>...] [--json]
```

`--only` applies exactly those fixes with no prompt and no terminal. `--json` prints `{ applied, alreadyApplied, failed }`. An id whose change an earlier id in the same run already made is reported in `alreadyApplied`; an unknown id, a finding without a fix or a stale fix is in `failed` and the exit code is 2.

To dismiss a false positive, put `// loadwise-reviewed <rule-id> -- <specific reason>` on the line above it. The finding becomes contextual with that reason. Only a real line comment counts, and declared contracts (`file-placement`, `folder-boundary`, `data-access-boundary`, `query-mutates-state`) cannot be dismissed this way.

## Changed lines

```sh
npx loadwise maint --staged .
npx loadwise maint --changed-since <git-ref> .
```

`--staged` reports only findings on lines added or changed in `git diff --cached`; `--changed-since <git-ref>` does the same for the working tree against that ref. A function-level finding (`high-branch-complexity`, `deep-control-flow`) is kept when a changed line falls anywhere inside its function. Text output is one block per finding (`path:line [rule-id #id] message`, then a `fix:` command when a rewrite exists and a `dismiss:` comment to paste above the line), ending with `N new finding(s) in changed lines.`. `--json` works too, with the same shape filtered. With no changed JS/TS files it prints nothing and exits 0 before TypeScript loads. In these modes `--fail-on` defaults to `all`, so the exit code is 1 whenever a finding remains.

Only the changed files are analysed, while imports still resolve through the whole project. When as many files changed as the full scan's parallel threshold (600), the full scan runs instead and its findings are filtered to the changed lines, so every rule applies. Otherwise rules that need every file are limited: `duplicate-implementation` is skipped and `dependency-cycle` only sees cycles made of changed files' imports. Boundary and placement rules still run. Analysis reads working-tree files, so a file with unstaged edits can report shifted lines.

## Developing locally

Use Node.js 22.12+ for the development tools and run `npm ci --include=optional`. Open this repository folder as a trusted workspace in VS Code or Cursor and enable the recommended Prettier extension. Saving a supported file formats it with the repository settings.

Run `npm run format` to format files, `npm run lint` for correctness checks, or `npm run check` to verify formatting, lint and tests together.

## License

Copyright © 2026 Ibrahim Hafez. All rights reserved. See LICENSE.
