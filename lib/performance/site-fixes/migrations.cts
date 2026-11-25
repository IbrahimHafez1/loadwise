// Site fixes for migration findings. A finding carries only its file and position, so the flagged
// statement, the framework and the transaction around it are re-read from the raw text of a .sql
// file, or from the query literal (or the up() function) of a TypeORM, Knex, MikroORM or
// Sequelize migration. Each rule turns the statement into replacement SQL; `place` then writes it
// back where it can run (in place, after COMMIT, or in its own migration).
import { requireReview } from './helpers.cjs';
import { migrationContext } from './migration-context.cjs';
import {
  breakingDrop,
  breakingRename,
  columnTypeRewrite,
  notNullWithoutDefault,
  setNotNullScan,
  volatileDefault,
} from './migration-column-rules.cjs';
import {
  concurrentInTransaction,
  constraintNotValid,
  constraintWithoutIndex,
  indexNotConcurrent,
  missingLockTimeout,
  mysqlLockUnspecified,
  mysqlTableCopy,
  tableRewriteCommand,
} from './migration-lock-rules.cjs';
import type { FixResult, SiteFixInput } from '../../shared/types.cjs';
import type { MigrationRule } from '../types/migrations.cjs';

function withContext(rule: MigrationRule): (input: SiteFixInput) => FixResult | undefined {
  return requireReview(
    'Rewrites SQL that runs against the database, so the schema, locking and transaction behaviour change.',
    (input: SiteFixInput) => {
      const context = migrationContext(input);
      return context && rule(context);
    },
  );
}

// migration-breaking-rename of a column and migration-unparsed have no builder: a safe column
// rename needs the column type (not in the finding), and SQL the parser rejected cannot be
// rewritten reliably.
export default {
  'migration-index-not-concurrent': withContext(indexNotConcurrent),
  'migration-concurrent-in-transaction': withContext(concurrentInTransaction),
  'migration-not-null-without-default': withContext(notNullWithoutDefault),
  'migration-volatile-default': withContext(volatileDefault),
  'migration-column-type-rewrite': withContext(columnTypeRewrite),
  'migration-set-not-null-scan': withContext(setNotNullScan),
  'migration-constraint-not-valid': withContext(constraintNotValid),
  'migration-constraint-without-index': withContext(constraintWithoutIndex),
  'migration-breaking-drop': withContext(breakingDrop),
  'migration-breaking-rename': withContext(breakingRename),
  'migration-missing-lock-timeout': withContext(missingLockTimeout),
  'migration-table-rewrite-command': withContext(tableRewriteCommand),
  'migration-mysql-table-copy': withContext(mysqlTableCopy),
  'migration-mysql-lock-unspecified': withContext(mysqlLockUnspecified),
};
