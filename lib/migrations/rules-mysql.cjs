'use strict';

// MySQL 8.x rules over tokenizer-recognized statements. Unrecognized statements were skipped, not guessed.

const { createFinding } = require('./operations.cjs');
const { breakingDrop, breakingRename, display, displaySql, isExistingTable } = require('./rules-postgres.cjs');

const COPY_REASONS = {
  'alter-column-type': 'changes a column definition (`MODIFY`/`CHANGE`)',
  'drop-primary-key': 'drops the primary key',
  'convert-charset': "converts the table's character set",
};
const ONLINE_STATEMENT_KINDS = new Set(['alter-table', 'create-index']);

function statementKey(operation) {
  return `${operation.line}:${operation.column}`;
}

function groupByStatement(operations) {
  const groups = new Map();
  for (const operation of operations) {
    const key = statementKey(operation);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(operation);
  }
  return [...groups.values()];
}

function copyReason(statement) {
  const [first] = statement;
  if (first.algorithm === 'COPY') return 'requests `ALGORITHM=COPY`';
  const copying = statement.find((operation) => COPY_REASONS[operation.kind]);
  return copying ? COPY_REASONS[copying.kind] : null;
}

function tableCopy(statement) {
  const [first] = statement;
  if (!isExistingTable(first)) return null;
  const reason = copyReason(statement);
  if (!reason) return null;
  const table = display(first.table, 'mysql');
  const fix =
    'Use an online schema change tool (`gh-ost` or `pt-online-schema-change`), or add a new column, backfill in batches and swap';
  return createFinding(first, 'migration-mysql-table-copy', {
    message: `\`${displaySql(first.sql)}\` ${reason}, which MySQL does with \`ALGORITHM=COPY\`: it rebuilds \`${table}\` and blocks writes until the copy finishes. ${fix}. Changing only a default or appending \`ENUM\` values can be instant; state \`ALGORITHM=INSTANT\` to have MySQL prove it.`,
    suggestion: fix + '.',
    example: { before: displaySql(first.sql), after: `gh-ost --alter="..." --table=${first.table}` },
  });
}

function isOnlineSafe(operation) {
  return operation.algorithm === 'INSTANT' || operation.lock === 'NONE';
}

function onlineClause(operation) {
  return operation.statementKind === 'create-index' ? ' ALGORITHM=INPLACE LOCK=NONE' : ', ALGORITHM=INPLACE, LOCK=NONE';
}

function lockUnspecified(statement) {
  const [first] = statement;
  if (!ONLINE_STATEMENT_KINDS.has(first.statementKind) || !isExistingTable(first) || isOnlineSafe(first)) return null;
  if (statement.every((operation) => operation.kind === 'rename-table')) return null;
  const fixed = displaySql(first.sql) + onlineClause(first);
  return createFinding(first, 'migration-mysql-lock-unspecified', {
    message: `\`${displaySql(first.sql)}\` does not state \`ALGORITHM\` and \`LOCK\`, so MySQL silently falls back to copying \`${display(first.table, 'mysql')}\` and blocking writes when it cannot alter in place. State \`ALGORITHM=INPLACE, LOCK=NONE\` so MySQL fails instead of silently copying the table. \`ALGORITHM=INSTANT\` also works for changes that support it, such as adding a column on MySQL 8.0.29+.`,
    suggestion: 'State `ALGORITHM=INPLACE, LOCK=NONE`.',
    example: { before: displaySql(first.sql), after: fixed },
  });
}

function notNullWithoutDefault(operation) {
  if (operation.kind !== 'add-column' || !operation.notNull || operation.hasDefault || operation.serial) return null;
  if (!isExistingTable(operation) || /\bAUTO_INCREMENT\b/i.test(operation.sql ?? '')) return null;
  const column = display(operation.columnName, 'mysql');
  const fix = 'Add an explicit `DEFAULT`, or add it nullable and enforce it once every running version writes it';
  return createFinding(operation, 'migration-not-null-without-default', {
    message: `\`ADD COLUMN ${column} ... NOT NULL\` has no default, so MySQL fills existing rows of \`${display(operation.table, 'mysql')}\` with the type's implicit default (\`0\`, \`''\`), and app versions still running that insert without \`${operation.columnName}\` fail in strict mode ("doesn't have a default value"). ${fix}. Check that the implicit value is a correct value for old rows.`,
    suggestion: fix + '.',
    example: { before: displaySql(operation.sql), after: `ADD COLUMN ${column} ... NOT NULL DEFAULT <value>` },
  });
}

// unit: { file, framework, dialect: 'mysql', operations } with operations annotated by annotateUnit.
function checkMysqlUnit(unit) {
  const findings = [];
  const shared = [breakingDrop, breakingRename, notNullWithoutDefault];
  for (const operation of unit.operations) {
    for (const rule of shared) {
      const finding = rule(operation, unit);
      if (finding) findings.push(finding);
    }
  }
  for (const statement of groupByStatement(unit.operations)) {
    const copy = tableCopy(statement);
    const finding = copy ?? lockUnspecified(statement);
    if (finding) findings.push(finding);
  }
  return findings.sort((left, right) => left.line - right.line || left.column - right.column);
}

module.exports = { checkMysqlUnit };
