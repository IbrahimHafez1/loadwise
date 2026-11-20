# Checker performance

These measurements use the actual CLI on Windows x64 with Node 26.13.1. Use the commands below to measure on your own code and hardware.

## Version 0.3.0

The default TypeScript engine now checks once per compiler program whether Drizzle declarations are loaded. A project without them can skip Drizzle-specific rule traversal. A six-run alternating comparison on a 668-file TypeORM project measured 3.76 seconds median with the optimization disabled and 3.13 seconds with it enabled. The full findings matched in every pair. An additional 277-file Drizzle project retained all 66 findings in that comparison. The native engine continues checking Drizzle through its existing adapter.

## Version 0.2.1 review

| Workload | Comparison | Local result |
| --- | --- | --- |
| 3,200 JS/TS files in eight referenced projects, default compiler | Locally installed 0.2.0 archive vs 0.2.1, three fresh processes each in alternating order | Median 1.549 s to 1.043 s (33% shorter). All six complete reports matched, including the 72 diagnostic locations. |
| Watch on the same 3,200 files, one edited source | Same rules with recursive traversal or reuse of syntax candidates, eight measured edits per variant after four warmups | Median analysis 225 to 155 ms. Median edit-to-report time including the watcher debounce went from 572 to 539 ms. Each snapshot correctly added or cleared one finding. |
| 24,000 OTLP spans, 480 expected groups | In-memory scan, 12 paired samples after warmup | Median 15.1 to 9.8 ms. On a second fixture with 720 findings including bound lookups, 34.0 to 23.5 ms. Complete results matched on every repetition. |

The default one-shot compiler now remembers file and directory existence for one run and shares the compiler library text across referenced configs. A separate instrumented scan on the 4,466-file VS Code checkout reduced physical directory probes from **71,651 to 3,408** and file probes from **33,101 to 6,417**. In the eight-project fixture, library snapshot sharing and probe reuse reduced reads from 3,737 to 3,296 and directory probes from 21,320 to 226. Watch mode uses TypeScript's live filesystem host and rechecks types against the current program on each edit. Its cache holds syntax candidates tied to the original source tree. Policies requiring block or import traversal use the full walk.

The trace reader validates each attribute value while reusing a recognized layout for consecutive non-database spans. Parsing JSON can dominate total time. Earlier parse-plus-scan trials on the same machine were nearly unchanged under different load. Compare the complete command on a representative export when budgeting CI time.

On VS Code, an instrumented run with the native compiler compared two traversals using the same rules. Walking the vendored SDK's node table and materializing candidates and parents created about 3.31 million JavaScript node objects, down from 8.15 million (59% fewer). In two runs per traversal, the Node process peak was 791–795 MiB with the new walk and 1,147–1,153 MiB with the recursive walk. Both produced the same 431 findings across 4,466 files. In one closely matched timing pair both took about 11.0 s. The memory measurements cover the Node process only. The Go compiler still parses the entire project. All 578,190 candidate node indices matched recursive traversal in exact order across the entire checkout. Targeted fixtures also cover decorators, TSX, optional chaining and JavaScript with JSDoc.

Maintained review fixtures cover unused lazy Prisma operations, mutations of a lookup collection inside a loop, guarded shared pools, invalid compiler option combinations, duplicate policy keys, customized scope fields, and mixed-case polyglot source extensions. The review also verified the six-library ORM integration with both engines. Focused examples measure these specific patterns. Production impact depends on the workload.

## Version 0.2.0

These CLI checks used the pinned checkouts described below, fresh Node processes and a warm OS file cache. Timing includes compiler startup, rule execution and JSON output. The 3,200-file fixture and VS Code native timings are medians of three consecutive runs. NestJS and TypeORM each have one reported timing in this series.

| Input | Files | Engine | Wall time | Candidates |
| --- | ---: | --- | ---: | ---: |
| VS Code 1.100.0, complete src config | 4,466 | Native | 6.69 s (6.61–7.09) | 431 |
| NestJS framework | 1,180 | Native | 0.86 s | 17 |
| TypeORM, original root config | 3,267 | Default | 7.88 s | 62 |
| Generated mixed JS/TS backend | 3,200 | Native | 0.84 s (0.80–0.86) | 72 |

The default compiler also scanned the 4,466-file VS Code project and produced an identical full JSON report. One run took 23.56 s while the automated test suite was active.

The synthetic diagnostics matched the previous version exactly. In VS Code, the new Promise rule identified two file handles closed with separate awaits inside one `Promise.allSettled` array in a test's cleanup. Inspecting the source confirmed that an early rejection would skip the second close and the combinator. Whether the test should wait for both handles on a failure is a maintainer decision. The other 430 VS Code locations and all 79 NestJS/TypeORM locations matched the earlier results. [VS Code cleanup code](https://github.com/microsoft/vscode/blob/19e0f9e681ecb8e5c09d8784acaa601316ca4571/src/vs/platform/files/test/node/diskFileService.integrationTest.ts#L2038)

All **14** original NestJS membership sites were reviewed against the linked upstream sources. Every site actually contained repeated membership checks. Two stock implementations used very short lists (four provider keys, or zero to three security-header options). The remaining twelve depended on runtime cardinality. This inspection establishes no latency regression in NestJS. Those suggestions remain advisories under `--fail-on contract`. [Nest provider keys](https://github.com/nestjs/nest/blob/09b656cb8df02a5f6ae1d0c5f1a0f2fadf7bc43c/packages/core/scanner.ts#L830) · [Nest header options](https://github.com/nestjs/nest/blob/09b656cb8df02a5f6ae1d0c5f1a0f2fadf7bc43c/packages/core/security/security-headers.ts#L72)

The original native scan on VS Code used 97,564 requests across the JS/Go boundary. Checking async context before resolving symbols and batching up to 256 candidate identifiers reduced requests to 10,958 in an instrumented build with the ORM rules, before adding the Promise and sorting rules. In a separate six-process interleaved comparison on the same 22 original rules, the baseline median was 24.68 s and the optimized median was 9.92 s. All six JSON outputs matched. That series ran under concurrent local workload. Absolute results vary with system load and project shape. The native compiler still materializes the syntax trees in JS.

The optional real-types integration checks TypeORM 0.3.28, Sequelize 6.37.7, Sequelize 7.0.0-alpha.47, Mongoose 8.19.1, Knex 3.1.0 and Kysely 0.28.8. Both compiler engines reported all 19 seeded findings at the same locations and left the control lines quiet. Separate fixtures used a generated Prisma 7.10.1 client, Drizzle 0.45.4 across PostgreSQL, MySQL and SQLite declarations, and `@types/pg` 8.23.1. A small SQLite check also ran an actual scoped Drizzle query against two tenants. These targeted checks measure behavior on known examples. They do not estimate precision for arbitrary applications.

The row-scope fixtures use different fields and authorization helpers in the same project, including `Invoice.organizationId` and `Workspace.workspace_id`. They cover incorrect field names, wrong helper provenance, and a run with row-scope checking disabled. In the SQLite test, Drizzle generated SQL for the physical column `org_id` while the checker recognized the public property `organizationId`.

## Version 0.1.0 real open-source projects

These are timed local runs against the repositories' own project configurations. The default engine uses the JavaScript TypeScript compiler. The optional native engine uses Microsoft's Go compiler through its 7.1 beta API. The scanner itself emitted no project files.

| Source tree | Input files | Default | Native | Result |
| --- | ---: | ---: | ---: | --- |
| Visual Studio Code 1.100.0, complete `src/tsconfig.json` | 4,466 | 10.91 s | 10.20 s | 430 identical findings, including messages and locations |
| TypeORM, commit `7a9009d299c1`, original root config | 3,267 | 7.13 s | TS5108 | 62 findings, identical across two successful default runs |
| NestJS 12.0.0 framework checkout, commit `27b0cb024d17` | 1,180 | 6.18 s | 1.53 s | 17 identical findings |

**VS Code** included 1,379,848 source lines and its test directories. Of 430 findings, 271 were under test directories. The release's seven configured type roots and Node types were installed from its lockfile. All relative imports resolved. Of 76 distinct external import specifiers, 49 lacked declarations in this source-only checkout. Type-dependent checks can miss calls using those imports. The final default process peaked at 1,994 MiB. The native process tree peaked at a sampled 2,340 MiB combined, with working sets sampled every 50 ms. Earlier runs on the same machine took 28.0 and 18.0 s, respectively. The 1,536 MiB default-engine heap trial failed; successful full runs used a 2,560 MiB ceiling. [VS Code source release](https://github.com/microsoft/vscode/tree/19e0f9e681ecb8e5c09d8784acaa601316ca4571)

**TypeORM** included 290,241 source lines. All 47 distinct external import specifiers resolved to declarations. The default engine peaked at 535 MiB. Its original config requests Node 10 module resolution, which the native compiler rejects. A clean snapshot preserved the local checkout. An example finding is the per-column array search in `AuroraMysqlDriver.findChangedColumns`. [TypeORM source revision](https://github.com/typeorm/typeorm/tree/7a9009d299c178b37adeb5369e5d6de6efd6d93d)

**NestJS** used installed dependencies and a clean local fork with one additional commit above upstream `09b656cb8df0`. The earlier eight-rule build reported 14 occurrences of the repeated array-membership pattern. All 14 locations also exist in the upstream files. Adding checks for loop copies and filtering only for existence brought the total to 17. For example, route comparison can search the right-hand list for every left-hand version. The useful tradeoff depends on typical list lengths and how frequently the path executes. [Upstream route comparison](https://github.com/nestjs/nest/blob/09b656cb8df02a5f6ae1d0c5f1a0f2fadf7bc43c/packages/core/router/route-conflict-detector.ts#L685)

## Version 0.1.0 synthetic project and edit latency

A generated backend contains 3,200 JavaScript and TypeScript files, 23,240 source lines and eight services with imports between models, handlers and queries. Each run checks all 72 expected diagnostic locations, including JavaScript clients typed only through JSDoc. Each timing launches a fresh process and includes compiler loading, project setup, rule evaluation and JSON output. The OS file cache was left warm. Peak RSS is the high-water mark of the CLI process.

The multi-project scanner shares parsed copies of the compiler's bundled declaration files across compatible compiler settings. It checks an overlapping source file under each config, where the same expression can resolve to different types. Source files follow the compiler's logical paths so differently resolved symlink aliases get checked.

| Final rule set, three fresh processes per cell | Default median | Native median |
| --- | ---: | ---: |
| All 3,200 files in one project | 2.234 s | 1.071 s |
| The same files in eight referenced projects | 2.606 s | 1.270 s |

Both engines returned the 72 exact expected findings on all twelve runs. The workload includes many typed query sites and 72 deliberate per-item queries. `npm run bench:scan -- --large --native` runs the native variant.

To reproduce the corpus, run `npm run bench:scan -- --large` from the source folder. The small `npm run bench:scan` benchmark separates compiler setup and rule analysis. In an initial small workload of 52 app modules they took 91.4 ms and 4.4 ms respectively, excluding Node startup and compiler module loading.

In the final 22-rule watch test, six alternating edits added and cleared a finding in the 3,200-file project. Each complete snapshot contained the expected 72 or 73 findings. Edit-to-result time was a median of 344 ms (335–368 ms), including TypeScript's 250 ms event debounce. Initial watch startup was 5.53 s and peak RSS was 310 MiB.

The polyglot source checker separately scanned 756 real Python 3.12 standard-library files (production modules, tests excluded). It returned zero findings on four runs. With parsing-error validation enabled, its first check took 386 ms and three further runs had a 383 ms median including native process startup.

## Trace exports

The trace benchmark used 24,000 spans (11.1 MiB of JSON), including 4,800 eligible DB spans and 480 expected groups. It checked the complete output on every run. The optimized reader indexes attributes in one pass and reuses bounded operation-signature fingerprints.

| Local measurement | Before | After |
| --- | ---: | ---: |
| Inspect already-parsed export | 23.9 ms | 19.5 ms |
| Parse JSON string and inspect | 66.5 ms | 59.4 ms |

These are local medians from an interleaved run against the saved pre-optimization implementation. The trace numbers exclude process startup and disk I/O. Run `npm run bench:traces` to reproduce the workload, or add `-- --cache-lookups` for the 720-finding fixture with identical key reads.

## Application behavior

The application-pattern benchmark uses Node's in-memory SQLite, prepared statements and an index. Fetching one page of 300 customers and their orders took 301 statements with per-customer lookups and two with batching. Both variants returned equal, ordered results including customers with zero orders. The collection comparisons include the cost of building the lookup Set.

A separate integration check used Python 3.12, the OpenTelemetry SDK and its sqlite3 instrumentor. SQLite's trace callback recorded nine statements to build eight rows. The checker reported a group of eight repeated child lookups. The batched version made one statement, returned the same ordered rows and passed. Both legacy and stable OTel database attributes were exercised. The integration converted the SDK's OTLP protobuf message to OTLP JSON locally.

Run `npm run bench:patterns` to compare application code. Its output measures the example workload. It makes no prediction about network round-trips, production caches or real database latency.

## Live database checks

| Engine | Measured outcome on isolated test data |
| --- | --- |
| PostgreSQL 18.0 | A sequential scan examined 20,000 rows for one match. Adding an index preserved the row and cleared the finding. An offset page walked 15,010 rows to return ten. Keyset pagination read ten and returned the same ten. The checker also found a 4,088 KiB disk sort. |
| MongoDB 8.2.3 | A collection scan examined 20,000 documents for one match. Indexing reduced that to one. Deep skip walked 15,010 index entries even though top-level documents examined was only ten. The keyset query returned the same documents and passed. A separate sort spilled 79 times and was detected. |
| Redis 7.2.16 | Python instrumentation captured a real `KEYS` operation. Incremental `SCAN` returned the same fixture key and passed. Eight default-redacted GETs produced a batching finding. Eight reads of a visible synthetic key produced a request-local reuse finding. One GET reused eight times returned the same values and passed. |

SQL Server, MySQL, MariaDB, DynamoDB, Cassandra and additional language/driver combinations are covered by contract fixtures where noted in the README. The live database checks above establish a different level of evidence.

