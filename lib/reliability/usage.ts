const reliabilityUsage = `Usage:
  loadwise rel [-p tsconfig.json | -p monorepo-root [--workspace name|path ...] | file.ts file.js ...] [--engine auto|native|js] [--policy policy.json] [--loadwise-config loadwise.config.json] [--schema snapshot.json] [--json | --format text|json|sarif|github] [--include-contextual] [--ignore rule-id] [--min-impact low|medium|high|critical] [--fail-on all|contract] [--baseline [file] | --write-baseline [file]] [--fix [--yes | --only id,...] [--no-comments] [--no-format]]
  loadwise rel [-p tsconfig.json] (--staged | --changed-since git-ref) [--json] [--include-contextual] [--ignore rule-id]
  loadwise rel contracts [--changed-since git-ref] [--json]
  loadwise rel migrations [paths...] [--changed-since git-ref] [--baseline file] [--write-baseline] [--dialect postgres|mysql] [--json] [--include-contextual] [--ignore rule-id]
  loadwise rel polyglot <file-or-directory> ... [--json]

The reliability checker finds code that fails at runtime or under concurrency: unhandled rejections, swallowed errors, races, missing timeouts and idempotency, transactions that escape their client, and unsafe migrations and API changes.
It shares the source check of loadwise perf: the same project discovery, policy, config, engines, baselines and fix flags apply, and \`loadwise check\` type-checks the project once for both.
A loadwise.config.json "rules" and "overrides" entry for a reliability rule applies here; findings live in the "reliability" section of the baseline file.
--fix --only id1,id2 applies exactly those findings' fixes without asking; with --json it prints { applied, alreadyApplied, failed }.
--fail-on contract exits 1 only for pg-transaction-on-pool.
migrations reads migration files only; contracts compares the working tree with the merge base of a git ref.
loadwise perf --watch, used by the editor, also shows reliability findings.
Exit codes: 0 passed, 1 findings meeting the exit threshold, 2 invalid input or configuration.`;

export { reliabilityUsage };
