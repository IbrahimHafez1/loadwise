// `loadwise perf migrations ...`: static migration safety checks. Never connects to a database.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { collectPaths, discoverMigrations } from './discover.cjs';
import { definesUpFunction, extractCodeFile } from './extract-code.cjs';
import { extractSqlText, prepareDialect, sqlFileInTransaction } from './extract-sql.cjs';
import {
  DEFAULT_BASELINE_NAME,
  applyReviewComments,
  baselinePolicy,
  changedSincePolicy,
  enforceAllPolicy,
  readBaseline,
  writeBaseline,
} from './enforce.cjs';
import { MIGRATION_RULES, annotateUnit } from './operations.cjs';
import { checkMysqlUnit } from './rules-mysql.cjs';
import { checkPostgresUnit, createPostgresRegistry } from './rules-postgres.cjs';
import { assignFindingIds } from '../finding-ids.cjs';
import { findingLabel } from '../finding-text.cjs';
import { findProjectRoot } from '../schema/context.cjs';
import { impactByRule } from '../rule-ids.cjs';
import {
  annotateImpact,
  filterMinImpact,
  parseMinImpact,
  sortByImpactWithinFiles,
} from '../../shared/impact-levels.cjs';
import type { Finding } from '../../shared/types.cjs';
import type { LoadedMigration, MigrationFile, MigrationPolicy } from '../types/migration-files.cjs';
import type { MigrationDialect, MigrationFinding, MigrationUnit } from '../types/migration-operations.cjs';
import type { PostgresRegistry } from '../types/postgres-registry.cjs';

interface MigrationsResult {
  scannedFiles: number;
  findings: Finding[];
  contextualFindingCount?: number;
}

const usage = `Usage:
  loadwise perf migrations [paths...] [--changed-since <git-ref>] [--baseline <file>] [--write-baseline] [--dialect postgres|mysql] [--json] [--include-contextual] [--ignore rule-id] [--min-impact low|medium|high|critical]

With no paths, find Prisma, Drizzle, TypeORM, Knex and Sequelize migrations under the current directory.
Only new migrations fail. --changed-since <ref> enforces files added or modified since the merge base of <ref> and HEAD, plus untracked files.
Otherwise ${DEFAULT_BASELINE_NAME} in the current directory (or --baseline <file>) lists accepted migrations; --write-baseline writes it.
Findings in other migrations are contextual: counted, listed with --include-contextual, never exit 1.
--min-impact reports only findings at that impact level or above; the rest do not count toward the exit code.
Migration checks read files only and never connect to a database.
Exit codes: 0 passed, 1 findings in enforced migrations, 2 invalid input or configuration.`;

const DIALECTS = new Set(['postgres', 'mysql']);
const KNOWN_RULES = new Set(MIGRATION_RULES);

function isMigrationDialect(value: string): value is MigrationDialect {
  return DIALECTS.has(value);
}

function parseOptions(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      'changed-since': { type: 'string' },
      baseline: { type: 'string' },
      'write-baseline': { type: 'boolean', default: false },
      dialect: { type: 'string' },
      json: { type: 'boolean', default: false },
      'include-contextual': { type: 'boolean', default: false },
      ignore: { type: 'string', multiple: true, default: [] },
      'min-impact': { type: 'string' },
    },
  });
  if (values.dialect !== undefined && !isMigrationDialect(values.dialect)) {
    throw new Error('--dialect must be postgres or mysql.');
  }
  parseMinImpact(values['min-impact']);
  for (const ruleId of values.ignore) {
    if (!KNOWN_RULES.has(ruleId)) throw new Error('Unknown migration rule: ' + ruleId);
  }
  if (values['write-baseline'] && values['changed-since'] !== undefined) {
    throw new Error('--write-baseline records every migration; it cannot be combined with --changed-since.');
  }
  return { values: { ...values, dialect: values.dialect }, positionals };
}

type MigrationOptions = ReturnType<typeof parseOptions>['values'];

function displayPath(file: string, cwd: string) {
  const relative = path.relative(cwd, file);
  const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  return (inside ? relative : file).split(path.sep).join('/');
}

function findMigrations(positionals: string[], dialect: MigrationDialect | undefined, cwd: string) {
  const found =
    positionals.length > 0 ? collectPaths(positionals, { dialect, cwd }) : discoverMigrations(cwd, { dialect });
  for (const skipped of found.skipped) {
    console.error(`Skipped ${skipped} migrations: only Postgres and MySQL migrations are checked.`);
  }
  return readMigrations(found.files, cwd);
}

function readMigrations(files: readonly MigrationFile[], root: string): LoadedMigration[] {
  return files
    .map((file) => ({ ...file, text: fs.readFileSync(file.path, 'utf8'), displayPath: displayPath(file.path, root) }))
    .filter((migration) => migration.framework !== 'code' || definesUpFunction(migration.text, migration.path));
}

function selectPolicy(values: MigrationOptions, cwd: string, fileCount: number): MigrationPolicy {
  if (values['changed-since'] !== undefined) return changedSincePolicy(values['changed-since'], cwd);
  const baselineFile = path.resolve(cwd, values.baseline ?? DEFAULT_BASELINE_NAME);
  const baseline = readBaseline(baselineFile);
  if (baseline) return baselinePolicy(baselineFile, baseline);
  if (values.baseline !== undefined) {
    throw new Error(`Migration baseline not found: ${values.baseline}. Create it with --write-baseline.`);
  }
  console.error(
    `All ${fileCount} migration file(s) are enforced. Run \`loadwise perf migrations --write-baseline\` to accept the existing ones, or use \`--changed-since origin/main\` in CI.`,
  );
  return enforceAllPolicy();
}

function checkUnit(unit: MigrationUnit, registry: PostgresRegistry) {
  return unit.dialect === 'mysql' ? checkMysqlUnit(unit) : checkPostgresUnit(unit, registry);
}

function sqlFileFindings(migration: LoadedMigration, registry: PostgresRegistry) {
  const { operations, statementCount } = extractSqlText(migration.text, {
    dialect: migration.dialect,
    file: migration.displayPath,
  });
  annotateUnit(operations, {
    inTransaction: sqlFileInTransaction(migration.framework, statementCount),
    dialect: migration.dialect,
  });
  return checkUnit(
    { file: migration.displayPath, framework: migration.framework, dialect: migration.dialect, operations },
    registry,
  );
}

function codeFileFindings(migration: LoadedMigration, registry: PostgresRegistry) {
  const { framework, units } = extractCodeFile(migration.text, {
    file: migration.displayPath,
    dialect: migration.dialect,
  });
  return units.flatMap((unit) => {
    annotateUnit(unit.operations, { inTransaction: unit.inTransaction, dialect: migration.dialect });
    const unitFramework = framework === 'unknown' ? 'sql' : framework;
    return checkUnit(
      {
        file: migration.displayPath,
        framework: unitFramework,
        dialect: migration.dialect,
        operations: unit.operations,
      },
      registry,
    );
  });
}

// Files are checked in migration order so the Postgres registry knows earlier column types and
// checks.
function checkMigrations(migrations: LoadedMigration[], policy: MigrationPolicy) {
  const registry = createPostgresRegistry();
  const findings: MigrationFinding[] = [];
  for (const migration of migrations) {
    const isSqlFile = migration.framework !== 'code';
    const fileFindings = isSqlFile ? sqlFileFindings(migration, registry) : codeFileFindings(migration, registry);
    applyReviewComments(fileFindings, migration.text, isSqlFile);
    if (!policy.isEnforced(migration) && policy.reason !== null) {
      for (const finding of fileFindings) finding.contextualReason ??= policy.reason;
    }
    findings.push(...fileFindings);
  }
  return findings;
}

function printText(result: MigrationsResult, values: MigrationOptions) {
  for (const finding of result.findings) {
    const { file, line, column, message, contextualReason } = finding;
    console.log(
      `${file}:${line}:${column} ${findingLabel(finding)} ${finding.impactLevel}: ${message}${contextualReason ? ' (' + contextualReason + ')' : ''}`,
    );
  }
  console.log(`${result.scannedFiles} migration file(s) checked, ${result.findings.length} finding(s).`);
  if (result.contextualFindingCount && !values['include-contextual']) {
    console.log(`${result.contextualFindingCount} contextual finding(s) available with --include-contextual.`);
  }
}

async function runMigrations(argv: string[]): Promise<number> {
  const { values, positionals } = parseOptions(argv);
  if (values.help) {
    console.log(usage);
    return 0;
  }
  const cwd = process.cwd();
  const migrations = findMigrations(positionals, values.dialect, cwd);
  if (values['write-baseline']) {
    const baselineFile = path.resolve(cwd, values.baseline ?? DEFAULT_BASELINE_NAME);
    const count = writeBaseline(baselineFile, migrations);
    console.log(`Wrote ${count} migration file(s) to ${displayPath(baselineFile, cwd)}.`);
    return 0;
  }
  const policy = selectPolicy(values, cwd, migrations.length);
  if (migrations.some((migration) => migration.dialect === 'postgres')) await prepareDialect('postgres');
  const checked = assignFindingIds(checkMigrations(migrations, policy), findProjectRoot(cwd));
  const allFindings = sortByImpactWithinFiles(
    filterMinImpact(
      annotateImpact(checked, impactByRule).filter((finding: Finding) => !values.ignore.includes(finding.ruleId)),
      values['min-impact'],
    ),
  );
  const contextual = allFindings.filter((finding) => finding.contextualReason);
  const enforced = allFindings.filter((finding) => !finding.contextualReason);
  const result: MigrationsResult = {
    scannedFiles: migrations.length,
    findings: values['include-contextual'] ? allFindings : enforced,
  };
  if (contextual.length > 0) result.contextualFindingCount = contextual.length;
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else printText(result, values);
  return enforced.length > 0 ? 1 : 0;
}

// Editor entry: enforced findings for the migrations under `root`, judged by the baseline only (no
// git, no console output).
async function checkProjectMigrations({
  root,
  baseline = DEFAULT_BASELINE_NAME,
}: {
  root: string;
  baseline?: string;
}): Promise<MigrationFinding[]> {
  const { files } = discoverMigrations(root, {});
  const migrations = readMigrations(files, root);
  if (migrations.some((migration) => migration.dialect === 'postgres')) await prepareDialect('postgres');
  const baselineFile = path.resolve(root, baseline);
  const accepted = readBaseline(baselineFile);
  const policy = accepted ? baselinePolicy(baselineFile, accepted) : enforceAllPolicy();
  return checkMigrations(migrations, policy).filter((finding) => !finding.contextualReason);
}

// Contract with bin: argv is everything after `migrations`; resolves to the exit code (0, 1 or 2).
async function run(argv: string[]): Promise<number> {
  try {
    return await runMigrations(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export { run, usage, checkProjectMigrations };
