'use strict';

const { createPositionIndex } = require('../sql/locations.cjs');
const pgParser = require('../sql/pg-parser.cjs');
const { parseMysqlStatements } = require('../sql/mysql-tokens.cjs');
const { createOperation, containsPlaceholder } = require('./operations.cjs');

const DATA_STATEMENTS = new Set(['InsertStmt', 'UpdateStmt', 'DeleteStmt', 'SelectStmt', 'CopyStmt', 'MergeStmt']);
const CONSTRAINT_TYPES = {
  CONSTR_FOREIGN: 'foreign',
  CONSTR_CHECK: 'check',
  CONSTR_UNIQUE: 'unique',
  CONSTR_PRIMARY: 'primary',
  CONSTR_EXCLUSION: 'exclusion',
};
const SET_CONFIG_LOCK_TIMEOUT = /set_config\s*\(\s*'lock_timeout'/i;
const MYSQL_CREATE_TABLE =
  /^\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[`"]?[\w$]+[`"]?\.)?[`"]?([\w$]+)[`"]?/i;
const MYSQL_TRANSACTION_START = /^\s*(?:START\s+TRANSACTION|BEGIN)\b/i;
const MYSQL_TRANSACTION_END = /^\s*(?:COMMIT|ROLLBACK)\b/i;
const MYSQL_DATA = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|SELECT|SET|CALL|WITH)\b/i;

function stringValue(node) {
  return node?.String?.sval ?? null;
}

function lastName(items) {
  return stringValue((items ?? []).at(-1));
}

function describeType(typeName) {
  if (!typeName) return null;
  const name = lastName(typeName.names);
  const modifiers = (typeName.typmods ?? []).map((modifier) => modifier.A_Const?.ival?.ival ?? null);
  return { name, modifiers, array: (typeName.arrayBounds ?? []).length > 0 };
}

function constantValue(node) {
  const constant = node?.A_Const;
  if (!constant) return null;
  if (constant.ival) return String(constant.ival.ival ?? 0);
  if (constant.sval) return constant.sval.sval;
  return null;
}

function isLockTimeoutDisabled(args) {
  const value = constantValue((args ?? [])[0]);
  return value === '0' || value === '0s' || value === '0ms';
}

function notNullColumnOfCheck(expression) {
  const test = expression?.NullTest;
  if (!test || test.nulltesttype !== 'IS_NOT_NULL') return null;
  const fields = test.arg?.ColumnRef?.fields ?? [];
  return fields.length === 1 ? stringValue(fields[0]) : null;
}

function describeColumnDefinition(definition) {
  const constraints = (definition.constraints ?? []).map((constraint) => constraint.Constraint);
  const defaultConstraint = constraints.find((constraint) => constraint.contype === 'CONSTR_DEFAULT');
  const type = describeType(definition.typeName);
  return {
    columnName: definition.colname,
    type,
    notNull: constraints.some((constraint) => ['CONSTR_NOTNULL', 'CONSTR_PRIMARY'].includes(constraint.contype)),
    hasDefault: Boolean(defaultConstraint),
    defaultExpression: defaultConstraint?.raw_expr ?? null,
    identity: constraints.some((constraint) => constraint.contype === 'CONSTR_IDENTITY'),
    generatedStored: constraints.some((constraint) => constraint.contype === 'CONSTR_GENERATED'),
    serial: /^(?:small|big)?serial[248]?$/.test(type?.name ?? ''),
  };
}

function describeConstraint(constraint) {
  return {
    constraintType: CONSTRAINT_TYPES[constraint.contype] ?? 'other',
    constraintName: constraint.conname ?? null,
    notValid: Boolean(constraint.skip_validation),
    usingIndex: Boolean(constraint.indexname),
    checkNotNullColumn: constraint.contype === 'CONSTR_CHECK' ? notNullColumnOfCheck(constraint.raw_expr) : null,
  };
}

function alterCommandFields(command) {
  switch (command.subtype) {
    case 'AT_AddColumn':
      return {
        kind: 'add-column',
        location: command.def.ColumnDef.location,
        ...describeColumnDefinition(command.def.ColumnDef),
      };
    case 'AT_AlterColumnType':
      return {
        kind: 'alter-column-type',
        columnName: command.name,
        type: describeType(command.def?.ColumnDef?.typeName),
        hasUsing: Boolean(command.def?.ColumnDef?.raw_default),
        location: command.def?.ColumnDef?.location,
      };
    case 'AT_SetNotNull':
      return { kind: 'set-not-null', columnName: command.name };
    case 'AT_AddConstraint':
      return {
        kind: 'add-constraint',
        location: command.def.Constraint.location,
        ...describeConstraint(command.def.Constraint),
      };
    case 'AT_ValidateConstraint':
      return { kind: 'validate-constraint', constraintName: command.name };
    case 'AT_DropColumn':
      return { kind: 'drop-column', columnName: command.name };
    default:
      return { kind: 'alter-table-other', subtype: command.subtype, columnName: command.name ?? null };
  }
}

function postgresOperations(statement, base) {
  const node = statement.node;
  const kind = statement.kind;
  const body = node[kind];
  switch (kind) {
    case 'CreateStmt':
      return [
        {
          ...base,
          kind: 'create-table',
          table: body.relation.relname,
          columns: (body.tableElts ?? [])
            .filter((element) => element.ColumnDef)
            .map((element) => ({ name: element.ColumnDef.colname, type: describeType(element.ColumnDef.typeName) })),
        },
      ];
    case 'CreateTableAsStmt':
      return [{ ...base, kind: 'create-table', table: body.into?.rel?.relname ?? null }];
    case 'IndexStmt':
      return [
        {
          ...base,
          kind: 'create-index',
          table: body.relation.relname,
          index: body.idxname ?? null,
          concurrent: Boolean(body.concurrent),
          unique: Boolean(body.unique),
          // `CREATE INDEX ... ON ONLY parent` cannot be concurrent; it is the documented partitioned-table recipe.
          onlyParent: body.relation.inh !== true,
        },
      ];
    case 'DropStmt':
      return dropOperations(body, base);
    case 'AlterTableStmt':
      if (body.objtype !== 'OBJECT_TABLE') return [{ ...base, kind: 'other' }];
      return (body.cmds ?? []).map((entry) => ({
        ...base,
        table: body.relation.relname,
        ...alterCommandFields(entry.AlterTableCmd),
      }));
    case 'RenameStmt':
      return [renameOperation(body, base)];
    case 'VariableSetStmt':
      if (body.name === 'lock_timeout' && !isLockTimeoutDisabled(body.args))
        return [{ ...base, kind: 'set-lock-timeout' }];
      return [{ ...base, kind: 'other' }];
    case 'TransactionStmt':
      return [transactionOperation(body, base)];
    case 'VacuumStmt':
      return (body.options ?? []).some((option) => option.DefElem?.defname === 'full')
        ? [{ ...base, kind: 'table-rewrite-command', command: 'VACUUM FULL', table: vacuumTable(body) }]
        : [{ ...base, kind: 'other' }];
    case 'ClusterStmt':
      return [{ ...base, kind: 'table-rewrite-command', command: 'CLUSTER', table: body.relation?.relname ?? null }];
    case 'ReindexStmt':
      return [
        {
          ...base,
          kind: 'table-rewrite-command',
          command: 'REINDEX',
          table: body.relation?.relname ?? null,
          concurrent: (body.params ?? []).some((parameter) => parameter.DefElem?.defname === 'concurrently'),
        },
      ];
    case 'CreateTrigStmt':
      return [{ ...base, kind: 'alter-table-other', table: body.relation?.relname ?? null, subtype: 'trigger' }];
    default:
      if (kind === 'SelectStmt' && SET_CONFIG_LOCK_TIMEOUT.test(statement.text))
        return [{ ...base, kind: 'set-lock-timeout' }];
      return [{ ...base, kind: DATA_STATEMENTS.has(kind) ? 'data' : 'other' }];
  }
}

function vacuumTable(body) {
  return body.rels?.[0]?.VacuumRelation?.relation?.relname ?? null;
}

function dropOperations(body, base) {
  if (body.removeType === 'OBJECT_TABLE') {
    return (body.objects ?? []).map((object) => ({ ...base, kind: 'drop-table', table: lastName(object.List?.items) }));
  }
  if (body.removeType === 'OBJECT_INDEX') {
    return [
      {
        ...base,
        kind: 'drop-index',
        concurrent: Boolean(body.concurrent),
        index: lastName(body.objects?.[0]?.List?.items),
      },
    ];
  }
  return [{ ...base, kind: 'other' }];
}

function renameOperation(body, base) {
  if (body.renameType === 'OBJECT_COLUMN' && body.relationType === 'OBJECT_TABLE') {
    return {
      ...base,
      kind: 'rename-column',
      table: body.relation.relname,
      columnName: body.subname,
      newName: body.newname,
    };
  }
  if (body.renameType === 'OBJECT_TABLE') {
    return { ...base, kind: 'rename-table', table: body.relation.relname, newName: body.newname };
  }
  return { ...base, kind: 'other' };
}

function transactionOperation(body, base) {
  if (['TRANS_STMT_BEGIN', 'TRANS_STMT_START'].includes(body.kind)) return { ...base, kind: 'transaction-begin' };
  if (['TRANS_STMT_COMMIT', 'TRANS_STMT_ROLLBACK'].includes(body.kind)) return { ...base, kind: 'transaction-end' };
  return { ...base, kind: 'other' };
}

function lineStartsOf(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') starts.push(index + 1);
  return starts;
}

// `mapOffset` turns a character offset in `sqlText` into a file position; .sql files map 1:1, query literals do not.
function defaultMapper(sqlText) {
  const index = createPositionIndex(sqlText);
  return (offset) => index.fromCharOffset(offset);
}

const UNLOCATED_COMMAND_KINDS = new Set(['drop-column', 'set-not-null', 'validate-constraint', 'alter-table-other']);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Offset of identifier `name` (quoted exactly, or unquoted case-insensitively) at or after `from`, else -1.
function findName(text, name, from) {
  const pattern = new RegExp(
    `"${escapeRegExp(name.replaceAll('"', '""'))}"|(?<![\\w$"])${escapeRegExp(name)}(?![\\w$"])`,
    'gi',
  );
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match ? match.index : -1;
}

function extractPostgres(sqlText, { file, mapOffset }) {
  const lineStarts = lineStartsOf(sqlText);
  const operations = [];
  const statements = pgParser.parseStatements(sqlText);
  for (const statement of statements) {
    const statementIndex = createPositionIndex(statement.text);
    const relation = statement.node?.AlterTableStmt?.relation;
    let cursor = relation ? statementIndex.byteToCharOffset(relation.location) + relation.relname.length : 0;
    // Sub-commands without a parser location (DROP COLUMN, SET NOT NULL, ...) are placed at their name.
    const commandOffset = (location, fields) => {
      if (Number.isInteger(location) && location >= 0) {
        cursor = statementIndex.byteToCharOffset(location);
        return statement.start + cursor;
      }
      const name = UNLOCATED_COMMAND_KINDS.has(fields.kind) ? (fields.columnName ?? fields.constraintName) : null;
      const found = name ? findName(statement.text, name, cursor) : -1;
      if (found === -1) return statement.start;
      cursor = found + 1;
      return statement.start + found;
    };
    const base = {
      file,
      sql: statement.text,
      dynamic: containsPlaceholder(statement.text),
      statementStart: statement.start,
    };
    const fields = statement.error
      ? [{ ...base, kind: 'unparsed', parseError: statement.error }]
      : postgresOperations(statement, base);
    for (const { location, ...operationFields } of fields) {
      const position = mapOffset(commandOffset(location, operationFields));
      if (operationFields.parseError) {
        const { line, column } = operationFields.parseError;
        const errorOffset = (lineStarts[line - 1] ?? 0) + column - 1;
        operationFields.parseError = { ...operationFields.parseError, ...mapOffset(errorOffset) };
      }
      operations.push(createOperation({ ...operationFields, ...position }));
    }
  }
  return { operations, statementCount: statements.length };
}

function mysqlActionFields(action) {
  switch (action.type) {
    case 'add-column':
      return [
        { kind: 'add-column', columnName: action.column, notNull: action.notNull, hasDefault: action.hasDefault },
      ];
    case 'drop-column':
      return [{ kind: 'drop-column', columnName: action.column }];
    case 'rename-column':
      return [{ kind: 'rename-column', columnName: action.column, newName: action.newName }];
    case 'modify-column':
      return [{ kind: 'alter-column-type', columnName: action.column }];
    case 'change-column': {
      const renamed = action.newName && action.column && action.newName.toLowerCase() !== action.column.toLowerCase();
      const change = { kind: 'alter-column-type', columnName: action.newName ?? action.column };
      return renamed
        ? [{ kind: 'rename-column', columnName: action.column, newName: action.newName }, change]
        : [change];
    }
    case 'drop-primary-key':
      return [{ kind: 'drop-primary-key' }];
    case 'convert-charset':
      return [{ kind: 'convert-charset' }];
    case 'add-index':
      return [{ kind: 'create-index', unique: action.unique }];
    case 'add-constraint':
      return [{ kind: 'add-constraint', constraintType: action.primaryKey ? 'primary' : 'other' }];
    case 'drop-index':
      return [{ kind: 'drop-index', index: action.index }];
    case 'rename-table':
      return [{ kind: 'rename-table', newName: action.newName }];
    default:
      return [{ kind: 'alter-table-other', subtype: action.type }];
  }
}

function mysqlStatementFields(statement) {
  const options = { algorithm: statement.algorithm ?? null, lock: statement.lock ?? null };
  switch (statement.kind) {
    case 'alter-table':
      return statement.actions.flatMap((action) =>
        mysqlActionFields(action).map((fields) => ({ table: statement.table, ...options, ...fields })),
      );
    case 'create-index':
      return [
        { kind: 'create-index', table: statement.table, index: statement.index, unique: statement.unique, ...options },
      ];
    case 'drop-index':
      return [{ kind: 'drop-index', table: statement.table, index: statement.index, ...options }];
    case 'drop-table':
      return statement.tables.map(({ table }) => ({ kind: 'drop-table', table }));
    case 'rename-table':
      return statement.renames.map(({ from, to }) => ({ kind: 'rename-table', table: from.table, newName: to.table }));
    default:
      return [otherMysqlFields(statement.text)];
  }
}

function otherMysqlFields(text) {
  const created = MYSQL_CREATE_TABLE.exec(text);
  if (created) return { kind: 'create-table', table: created[1] };
  // MySQL commits implicitly around DDL, so transactions only matter for data statements; they are tracked anyway.
  if (MYSQL_TRANSACTION_START.test(text)) return { kind: 'transaction-begin' };
  if (MYSQL_TRANSACTION_END.test(text)) return { kind: 'transaction-end' };
  return { kind: MYSQL_DATA.test(text) ? 'data' : 'other' };
}

function extractMysql(sqlText, { file, mapOffset }) {
  const operations = [];
  const statements = parseMysqlStatements(sqlText);
  for (const statement of statements) {
    const base = {
      file,
      sql: statement.text,
      dynamic: containsPlaceholder(statement.text),
      statementStart: statement.start,
      statementKind: statement.kind,
    };
    const position = mapOffset(statement.start);
    for (const fields of mysqlStatementFields(statement)) {
      operations.push(createOperation({ ...base, ...fields, ...position }));
    }
  }
  return { operations, statementCount: statements.length };
}

// Postgres parsing needs the WASM module; callers await this once before extracting.
async function prepareDialect(dialect) {
  if (dialect === 'postgres') await pgParser.ensureLoaded();
}

function extractSqlText(sqlText, { dialect, file, mapOffset }) {
  const text = sqlText.charCodeAt(0) === 0xfeff ? sqlText.slice(1) : sqlText;
  const mapper = mapOffset ?? defaultMapper(text);
  if (dialect === 'mysql') return extractMysql(text, { file, mapOffset: mapper });
  return extractPostgres(text, { file, mapOffset: mapper });
}

// Prisma sends a multi-statement file as one implicit transaction; the Drizzle migrator wraps every file in one.
function sqlFileInTransaction(framework, statementCount) {
  if (framework === 'prisma') return statementCount > 1;
  return framework === 'drizzle';
}

module.exports = { prepareDialect, extractSqlText, sqlFileInTransaction };
