# backend-perf-check

Find repeated backend work before deployment or in a recorded request. The local CLI checks source code, OpenTelemetry traces and executed database plans. Findings include a location or trace identifier, a rule ID, and a suggested change to evaluate.

## What you get

| Capability                | Command                                  | Needs a database |
| ------------------------- | ---------------------------------------- | ---------------- |
| Source and ORM checks     | `backend-perf-check -p tsconfig.json`    | No               |
| Migration safety          | `backend-perf-check migrations`          | No               |
| Schema-aware index checks | `backend-perf-check --schema snap.json`  | No (snapshot)    |
| Live database inspection  | `backend-perf-check db`                  | Yes, read-only   |
| Traces and executed plans | `traces trace.json`, `plan explain.json` | No               |

Text findings carry a **Fix:** snippet where one applies and, for loops and repeated spans, an **Impact:** line. Impact always says which side is measured and which is estimated.

```text
examples/slow.ts:6:48 [array-repeated-find] Each item can rescan the lookup array with find(), so cost grows with items times rows. Build `const byKey = new Map()` once (first match wins) and call `byKey.get(key)`; keep the original key-equality semantics.
  Fix:
    const firstById = new Map();
    for (const row of rows) {
      if (!firstById.has(row.id)) firstById.set(row.id, row);
    }
    const matches = ids.map(id => firstById.get(id));
```

```text
00000000000000000000000000000001 parent 0000000000000010 [repeated-db-span] 5 sibling database calls share one operation signature, one round trip each. Batch them into one statement such as WHERE id = ANY($1), or reuse a shared result, if behavior allows it.
  Impact: 40 ms measured -> ~8 ms estimated; method: OTLP start/end times; after assumes one batched operation costs as much as the slowest span.
```

The second sample is `examples/repeated-db.otlp.json` with span timings added. A `~` marks an estimate. Loop findings (`*-query-in-loop`) show a round-trip model, and a measured figure only when `--schema` supplies a snapshot with a measured round trip. An Impact line in milliseconds is never printed without a measurement behind it.

## Start here

### Editor findings with the npm packages

Install this package as a project dev dependency. Install `maintainability-check` alongside it to include both checkers. Set up the editor task once from the project root.

```sh
npx backend-perf-check editor init
```

Commit the generated `.vscode/tasks.json` with your project. Open the trusted folder in VS Code or Cursor and allow automatic tasks once. The watcher starts on subsequent folder opens. If the folder was already open during setup, reopen it. **Tasks: Manage Automatic Tasks** controls the workspace's choice.

Saving a file or completing an ordinary source scan from the project terminal refreshes the active editor watcher. The editor uses its configured project and rules even when the terminal command uses different flags. A running watcher picks up checker package reinstalls. When upgrading from a version that predates automatic reload, reopen the folder once to load the new watcher.

Open **View > Problems** or hover over an underline. The first line shows a source-based rewrite, an illustrative example or a review action. The hover retains the original finding and, where applicable, the code comparison. The editor controls whether diagnostic text appears beside the code.

This uses built-in tasks across supported source languages, including mixed-language projects. It needs Node.js 20+ on PATH. The default performance scan uses a root `tsconfig.json` or `jsconfig.json`, or explicit JS/TS files discovered by the watcher. To use a particular config, append `-p` and its relative path to the task's arguments. Start the task from a folder with the performance package installed under `node_modules`. Other editors can still run the CLI directly. For syntax-highlighted hover examples and related-location links in VS Code or Cursor, an optional [editor extension](editor/README.md) is also available.

Use Node.js 20+ and point npm at the downloaded archive. From your application directory, install the package and run the first check.

```sh
npm install --save-dev --include=optional ./backend-perf-check-0.3.0.tgz
npx backend-perf-check -p tsconfig.json
```

Try the two included implementations of the same order lookup. The first reports three findings. The second preserves the result order, the first matching customer and the fallback for a missing customer.

```sh
npx backend-perf-check node_modules/backend-perf-check/examples/slow.ts
npx backend-perf-check node_modules/backend-perf-check/examples/indexed.ts
```

Use the same one-shot commands in CI. Exit **0** means no displayed finding met the fail threshold, **1** means at least one did and **2** means the check could not complete. Add `--json` for structured output.

Source checks summarize contextual findings separately. They include certain one-off blocking calls in CLI startup or unit tests and write advisories in test sources. Use `--include-contextual` to display every candidate and its reason. JSON includes `contextualFindingCount` when any remain after explicit rule exclusions. In the default view this count is additional to the displayed findings. In the expanded view these entries appear in `findings` with a `contextualReason`.

The default `--fail-on all` applies to the displayed findings. For a complete advisory report that only fails CI on a transaction-client or import contract violation, use `npx backend-perf-check --include-contextual --fail-on contract`. The two enforced rules are `pg-transaction-on-pool` and `data-access-boundary`.

| Input                                   | Command after `npx backend-perf-check`                             | Coverage                                                                            |
| --------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| JavaScript or TypeScript                | `-p tsconfig.json`, `--watch -p tsconfig.json` or `src/handler.ts` | Typed database calls, collection algorithms, connections and synchronous Node APIs. |
| Python, Go, Java, C#, Rust              | `polyglot src`                                                     | Five narrowly scoped source patterns powered by a Rust binary.                      |
| OTLP/JSON from any application language | `traces request.otlp.json --threshold 5`                           | Repeated SQL or NoSQL operations, duplicate lookups and Redis/Valkey commands.      |
| Executed PostgreSQL or MongoDB plan     | `plan explain.json`                                                | Inefficient scans, disk sorts and deep pagination at individual plan stages.        |

## Source checks

Run in the directory containing `tsconfig.json` or `jsconfig.json`, pass `-p path/to/config.json`, or give explicit JS/TS files. A project check scans the config's input files and follows project references. Declaration files supply types. A standalone file check uses ES2022 and NodeNext compiler defaults. Use a project config for aliases, custom libraries and JS projects with `allowJs`.

| JS/TS rule                                                                                                           | Trigger and review                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg-query-in-loop`, `prisma-query-in-loop`                                                                           | Per-item queries. Consider a parameterized set query, relation load or bulk write if ordering and transaction behavior permit it. Prisma can already batch compatible `findUnique` calls.                       |
| `pg-count-materialization`, `prisma-count-materialization`                                                           | Counting an immediately loaded result. Use a database count with equivalent predicates and handle its return type.                                                                                              |
| `pg-first-materialization`, `prisma-first-materialization`                                                           | Reading only index zero from an unbounded result. Preserve ordering and empty-result behavior when limiting the query.                                                                                          |
| `pg-filter-materialization`, `prisma-filter-materialization`                                                         | Applying a literal equality filter in JS after loading an unbounded result. Check database collation and null semantics before moving the predicate.                                                            |
| `pg-top-k-materialization`, `prisma-top-k-materialization`                                                           | Sorting an unbounded result with a numeric comparator to keep the top rows. Use database ordering and a limit with a stable tie-breaker.                                                                        |
| `array-repeated-membership`, `array-repeated-find`, `rebuild-lookup-in-loop`                                         | Repeated linear lookups or rebuilt indexes. Reuse a Set or Map if inputs are stable and enough lookups justify construction. Preserve first-match semantics with duplicate keys.                                |
| `reduce-copy-accumulator`, `loop-copy-accumulator`, `filter-for-existence`                                           | Copying a growing result or allocating a filtered array for a boolean test. Consider a private accumulator or a short-circuiting predicate.                                                                     |
| `pool-created-per-request-or-item`, `pg-unreleased-checkout`                                                         | A recognized pg, Prisma, MongoDB or Redis client/pool is created on a repeated path, or a chained pg checkout loses the client reference. Scope reuse to the right credentials and release checked-out clients. |
| `node-sync-fs-in-async`, `node-sync-compression-in-async`, `node-sync-crypto-in-async`, `node-sync-process-in-async` | A recognized synchronous API blocks an async function. Examples include `readFileSync`, `gzipSync`, `scryptSync` and `execFileSync`.                                                                            |
| `redis-command-in-loop`                                                                                              | A per-key Redis or Valkey command on a repeated path. Use a multi-key command or a bounded pipeline if cluster slots, ordering and error handling permit it. SCAN cursor loops are skipped.                     |
| `password-hash-sync-in-async`                                                                                        | `hashSync`, `compareSync` or `genSaltSync` from bcrypt or bcryptjs in an async function blocks the event loop for the whole hash. Use the promise form.                                                         |

Source diagnostics include a one-based line and column. Repeat `--ignore RULE` to omit specific JS/TS rules from a run. Keep your project's own type check in CI.

For an intentionally repeated operation, attach the review to that specific site. The comment must be on its own line immediately before the diagnostic line, name one exact rule and include a reason.

```ts
// backend-perf-reviewed pg-query-in-loop -- Each iteration measures a separate query-plan sample.
await client.query(statement);
```

The site remains available with `--include-contextual`. Source comments cannot lower either CI contract, a configured row-scope check, a Prisma transaction-client escape or a Prisma read-modify-write finding. Test-path context applies only to Prisma dependent writes and Drizzle whole-table writes. Application code, tests and scripts still participate in source analysis.

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

| Integrity rule                     | What to review                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg-transaction-on-pool`           | A standalone transaction-control statement is sent to a typed pool. Use the same checked-out client for the whole transaction and release it in `finally`.                                                                                                                                                                                                                                                                                  |
| `pg-dynamic-query-text`            | Runtime fragments enter SQL text directly. Bind data as parameters and verify how any dynamic identifiers are chosen and quoted. A finding is a code-review prompt.                                                                                                                                                                                                                                                                         |
| `prisma-transaction-client-escape` | A direct model operation uses the same outer client that opened an interactive transaction. Verify that the operation belongs inside that transaction.                                                                                                                                                                                                                                                                                      |
| `prisma-dependent-writes`          | Adjacent creates pass a value from the first record into the next write. Explicit single-key nested `connect` can use a custom unique field when generated types confirm a relation. Direct scalar assignments currently recognize `parent.id` going into a field ending in `Id` or `_id`. Other scalar foreign-key conventions can be missed. If both writes must succeed together, consider a nested write or an appropriate transaction. |
| `prisma-read-modify-write`         | A direct read of one row feeds a numeric update of the same field and key. Review atomic arithmetic, an optimistic version check or serializable execution with retries.                                                                                                                                                                                                                                                                    |
| `drizzle-unfiltered-write`         | An executed update/delete has no effective predicate in a recognized direct chain. An intentional whole-table maintenance operation can legitimately match.                                                                                                                                                                                                                                                                                 |

For Prisma, building an array of lazy queries alone is quiet. A sequential `await` inside a loop can trigger the rule. Same-tick `findUnique` callbacks can use Prisma's own batching, so these are left to runtime traces. [Prisma Client reference](https://www.prisma.io/docs/orm/reference/prisma-client-reference#prismapromise-behavior) · [Prisma transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions) · [node-postgres transactions](https://node-postgres.com/features/transactions) · [Drizzle conditional filters](https://orm.drizzle.team/docs/guides/conditional-filters-in-query)

### Project-defined access policy

Place `backend-perf.policy.json` beside the selected project config, or pass `--policy path/to/file.json`. Explicit source-file checks discover the policy in the working directory. A policy can use just the sections the project needs. Duplicate JSON keys within the same object produce a configuration error. [Example policy](examples/query-policy.json)

The performance and transaction rules run without any scope policy. Row-scope checks start when the project identifies the existing model or table, its scoped property, and the helper that supplies an authorized scalar. Columns such as `tenantId`, `organizationId` and `workspace_id` have no special meaning to the checker on their own. Database mappings can keep the original storage column name. [Prisma database mapping](https://www.prisma.io/docs/orm/prisma-schema/data-model/database-mapping) · [Drizzle schema declarations](https://orm.drizzle.team/docs/sql-schema-declaration)

Drizzle also supports configuring quoted properties such as `"org-id"` and accessing them with brackets. In Prisma's generated filters, `AND`, `OR` and `NOT` are logical operators. If a physical column uses one of these names, configure the Prisma property that maps to it.

`prismaScopes` maps each generated model to its own protected field and a named export from the project's trusted authorization module. With the supplied example, `db.invoice.findMany({ where: { organizationId: requireOrganization() } })` has the expected scope. Choose the names already used by the project. The scanner handles common reads, writes and upsert branches, and requires every alternative in an OR to preserve the scope. For dynamic or nested shapes it cannot establish, it emits `prisma-scope-unverified`. Proof requires strict null checks. With explicit source files and a policy, the CLI enables strict null checks for its analysis.

`drizzleScopes` names an exported table, its schema module, its scoped property and the trusted helper. For a direct executed query, `.where(eq(invoices.workspace_id, currentWorkspace()))` establishes the configured predicate in the example. Use the property exposed by the ORM. A project with `organizationId: text('org_id')` would configure `"field": "organizationId"`. Each table can use a different convention. A later `.where()` can replace the earlier condition. The rule checks the effective condition and can report `drizzle-scope-unverified` when a protected table appears in a recognized chain and scope, projection or write data needs review. Stored builders, prepared aliases, raw SQL and arbitrary helper-generated statements can fall outside this check.

`dataAccess` restricts runtime imports of named packages, their subpaths, or specified local database entry points to approved directories or files. It also handles literal dynamic imports, re-exports and unshadowed CommonJS imports. TypeScript erases `import type` and `export type`. With `verbatimModuleSyntax`, `import { type T } from 'module'` and its export equivalent can still load the module, so the boundary checks them. Configure the actual module names and paths your application uses. The rule can enforce a shared, reviewed access layer for any JS/TS ORM, including clients without a dedicated query adapter.

These checks assume the configured helper authenticates the caller and authorizes the returned scope. Middleware, injected or previously obtained clients, raw SQL, unrecognized query shapes and database row-level policies require separate verification. A clean run only describes the covered operations.

### Async work and sorting

| Rule                              | When it reports                                                                                                                                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promise-combinator-serial-await` | A built-in `Promise.all` or `Promise.allSettled` receives an array of two or more already-awaited calls with known promise types. Starting them together changes which calls run after a failure. With `allSettled`, it also changes how rejections are returned.     |
| `known-reads-awaited-serially`    | Two adjacent awaited reads come from a project-configured `parallelReads` group and the second call is independent of the first result in a supported straight-line shape.                                                                                            |
| `numeric-sort-for-extreme`        | A numeric comparison sort on a private copy, or a nonmutating numeric sort, is used only to retrieve its first or last value. A single-pass extreme can use constant extra space. Preserve empty input, NaN, sparse inputs and signed-zero semantics when applicable. |

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

## Migration safety

`npx backend-perf-check migrations` reads Prisma, Drizzle, TypeORM, Knex and Sequelize migrations (SQL or code) and flags statements that lock or rewrite a table. It reads files only. `--dialect postgres|mysql` selects the rule set, `--json` for structured output and `--ignore RULE` to skip a rule.

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
npx backend-perf-check migrations --changed-since origin/main
```

**Baseline workflow.** For a project with existing migrations, accept them once and enforce the rest.

```sh
npx backend-perf-check migrations --write-baseline   # writes backend-perf.migrations-baseline.json
npx backend-perf-check migrations                    # new migrations fail; baselined ones do not
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

`npx backend-perf-check polyglot src` accepts directories or individual `.py`, `.go`, `.java`, `.cs` and `.rs` files. It uses the optional ast-grep native binary and its syntax-tree patterns. Language-specific aliases and wrappers can fall outside a pattern. [ast-grep](https://ast-grep.github.io/)

| Rule                         | Example in a loop                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `python-copy-growing-list`   | A list initialized to `[]` is repeatedly assigned `items = items + [value]` in a simple loop. |
| `go-fixed-regexp-in-loop`    | `regexp.Compile("pattern")` or `regexp.MustCompile("pattern")`                                |
| `java-fixed-regex-in-loop`   | `Pattern.compile("pattern")`                                                                  |
| `csharp-fixed-regex-in-loop` | `new Regex("pattern")`                                                                        |
| `rust-fixed-regex-in-loop`   | `Regex::new("pattern")`                                                                       |

## Trace checks in other languages and databases

Supply a local **OTLP/JSON trace export** with `resourceSpans → scopeSpans → spans`. An OpenTelemetry Collector with a file export can produce this format. The CLI accepts one export object per invocation. For a collector output containing multiple JSON lines, pass the relevant export object for the request. Spans split across separate invocations count independently.

Try `npx backend-perf-check traces node_modules/backend-perf-check/examples/repeated-db.otlp.json`. The example reports five similar MongoDB operations under one parent. The trace rules use current and legacy database attributes and deduplicate span IDs.

| Rule                  | Evidence and interpretation                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repeated-db-span`    | Five similar sibling DB calls by default, grouped by resource, trace, parent and recorded database target. SQL statements, query summaries, operation/collection pairs and recognized DynamoDB `GetItem` events can provide signatures. Namespace-only MongoDB or DynamoDB groups call for inspection of the actual predicates.                                                                                                               |
| `redis-keys-scan`     | One Redis or Valkey `KEYS` command can scan the keyspace. For incremental iteration, account for duplicates and keys changing between `SCAN` calls.                                                                                                                                                                                                                                                                                           |
| `redis-repeated-read` | Repeated sibling `GET` or `HGET` calls. Consider compatible multi-key reads or bounded pipelining with appropriate cluster slots, ordering and error handling. Recognized pipeline children are excluded.                                                                                                                                                                                                                                     |
| `duplicate-key-read`  | Two or more reads with the same observable lookup, database target and recorded scalar context under one parent. The comparison accepts application-defined context keys. Supported evidence includes a concrete Redis `GET` key or a narrow SQL equality lookup with its bound parameter. Masked targets, ambiguous context, observed writes, transactions or failed calls suppress the suggestion where identity or freshness is uncertain. |

Matching keys in two reads are a reason to consider **request-local** reuse when authorization, freshness and ordering allow it. Keep existing telemetry redaction. A redacted key can still support a batching finding. Reports contain span IDs and counts and omit raw SQL, parameters and keys. Check `scannedSpans` and `eligibleDbSpans` when interpreting a clean result. Sampling, missing parents, different literal values and coarse summaries affect grouping. [OpenTelemetry database spans](https://opentelemetry.io/docs/specs/semconv/db/database-spans/) · [OTLP JSON encoding](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding)

## Executed query plans

Feed the CLI a JSON file from PostgreSQL `EXPLAIN (ANALYZE, FORMAT JSON)` or MongoDB `explain("executionStats")`. For example, run `npx backend-perf-check plan node_modules/backend-perf-check/examples/postgres-plan.json`. The checker reads the file locally. PostgreSQL's `ANALYZE` option executes the statement when you collect the plan. [PostgreSQL EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html) · [MongoDB explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)

| Observed work                                 | Threshold and review                                                                                                                                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg-sequential-scan`, `mongo-collection-scan` | At least 1,000 examined and at least 100 examined per returned record, treating zero returns as one for this ratio. Review selectivity and available indexes. PostgreSQL totals use the reported per-loop averages.                                   |
| `pg-disk-sort`, `mongo-disk-sort`             | At least 1,024 KiB of disk use by a PostgreSQL sort participant, including a reported incremental-sort group peak, or at least 1 MiB of spill or eight spills on a MongoDB sort. Check whether earlier filtering or an index can reduce sorting work. |
| `pg-deep-offset`, `mongo-deep-skip`           | At least ten times as many entries walked as returned and at least 10,000 skipped per execution. For sequential pages, keyset pagination needs a stable ordering with a unique tie-breaker.                                                           |

Results include the stage path and observed counts. PostgreSQL and MongoDB planner estimates alone return exit 2. MongoDB coverage includes classic executed query stages and selected slot-based scan/filter and skip shapes. Unsupported layouts return an input error where a scan cannot be attributed.

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
node bin/backend-perf-check.cjs -p examples
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

## Developing locally

Use Node.js 20.19+ (20.x) or 22.12 and later for the development tools and run `npm ci --include=optional`. Open this repository folder as a trusted workspace in VS Code or Cursor and enable the recommended Prettier extension. Saving a supported file formats it with the repository settings.

Run `npm run format` to format files, `npm run lint` for correctness checks, or `npm run check` to verify formatting, lint and tests together.
