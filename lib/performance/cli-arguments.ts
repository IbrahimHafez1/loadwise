import fs from 'node:fs';
import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';

const usage = `Usage:
  loadwise perf [-p tsconfig.json | -p monorepo-root [--workspace name|path ...] | file.ts file.js ...] [--engine auto|native|js] [--policy policy.json] [--loadwise-config loadwise.config.json] [--schema snapshot.json] [--json | --format text|json|sarif|github] [--include-contextual] [--ignore rule-id] [--min-impact low|medium|high|critical] [--fail-on all|contract] [--baseline [file] | --write-baseline [file]] [--fix [--yes | --only id,...] [--no-comments] [--no-format]]
  loadwise perf [-p tsconfig.json] (--staged | --changed-since git-ref) [--json] [--include-contextual] [--ignore rule-id]
  loadwise perf --watch [-p tsconfig.json] [--policy policy.json] [--schema snapshot.json] [--include-contextual] [--ignore rule-id]
  loadwise perf db [--url-env DATABASE_URL] [--env-file .env] [--engine postgres|mysql|mongo] [--schema-snapshot out.json] [--top 20] [--queries file.sql] [--analyze] [--measure --i-understand-this-locks-tables] [--runs 5] [--json] [--ignore rule-id]
  loadwise perf traces trace.json [--threshold 5] [--json]
  loadwise perf plan explain.json [--json]
  loadwise perf polyglot <file-or-directory> ... [--json]
  loadwise perf agent init [--mode ask|auto] [--hook [block|warn|off]]

With no arguments, check tsconfig.json or jsconfig.json in the current directory.
In a monorepo root without one, every workspace package (package.json "workspaces", pnpm-workspace.yaml or lerna.json) with its own tsconfig.json or jsconfig.json is checked in one report; --workspace limits it to the named packages or folders.
A loadwise.config.json beside the selected config (or in the working directory for explicit files) supplies the query policy in its "performance" section; --policy names a policy file instead. Its ignore, rules and overrides filter the findings; --loadwise-config names another file.
--fix shows each available code fix and asks before applying it; --fix --yes applies eligible fixes without asking.
--fix --only id1,id2 applies exactly those findings' fixes without asking; with --json it prints { applied, alreadyApplied, failed }.
--fix adds a "// Loadwise <rule-id>: <why>" comment above each fixed statement and formats the changed lines with the project's Prettier; --no-comments and --no-format turn these off.
Every finding has a stable id (shown as #id); a failed --only id exits 2.
--write-baseline records the current findings in loadwise-baseline.json (or the given file); --baseline hides them so only new findings are reported and reports how many were hidden.
The baseline file has one section per checker, shared with loadwise maint and loadwise check; entries are matched by rule, file and flagged code, not line number.
--staged and --changed-since report only findings on lines changed in the git index or since a ref, with a fix and a dismiss command per finding.
agent init writes one block of instructions for AI coding agents, covering every checker, into AGENTS.md and imports it from CLAUDE.md.
agent init --hook installs one git pre-commit hook that runs \`loadwise check --staged\`: block fails the commit on findings, warn only prints them, off removes the hook. --hook alone means warn.
Source checks summarize contextual findings. --include-contextual includes their locations and review reasons.
Source checks use the TypeScript 7 native compiler when it is installed and accepts the project, otherwise TypeScript 6.
--engine native requires TypeScript 7 (--native is an alias). --engine js always uses TypeScript 6.
--fail-on contract exits 1 only for contract rules; performance has none of its own.
--min-impact reports only findings at that impact level or above; the rest do not count toward the exit code.
--format sarif and github print the findings for GitHub code scanning and workflow annotations; --json is --format json.
--schema reads a snapshot written by db --schema-snapshot; it refines index checks with table sizes and measured round trips.
Migration and API contract checks moved to loadwise rel migrations and loadwise rel contracts; the perf names still work.
Only the db command connects to a database. Every other command works from files alone.
The traces command reads one OTLP/JSON export. Its threshold counts sibling DB spans.
Exit codes: 0 passed, 1 findings meeting the exit threshold, 2 invalid input or configuration.`;

export function readJsonFile(filename: string, label: string): unknown {
  const raw = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(label + ' file contains invalid JSON.');
  }
}

export function parseCommand<Options extends NonNullable<ParseArgsConfig['options']>>(
  args: readonly string[],
  options: Options,
) {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' }, ...options },
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// `text` is another command's usage, such as `loadwise rel`'s, which shares the source check.
export function showHelp(text: string = usage): number {
  console.log(text);
  return 0;
}
