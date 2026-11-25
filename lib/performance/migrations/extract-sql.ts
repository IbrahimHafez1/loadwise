import { createPositionIndex } from '../sql/locations.js';
import * as pgParser from '../sql/pg-parser.js';
import { parseMysqlStatements } from '../sql/mysql-tokens.js';
import { createOperation, containsPlaceholder } from './operations.js';
import type {
  AlterTableCmd,
  ColumnDef,
  Constraint,
  DropStmt,
  RenameStmt,
  TransactionStmt,
  TypeName,
  VacuumStmt,
} from '@pgsql/types';
import type { OffsetMapper, SqlExtraction, SqlExtractionOptions } from '../types/migration-extraction.js';
import type {
  ColumnType,
  ConstraintType,
  MigrationDialect,
  MigrationOperation,
  OperationInit,
} from '../types/migration-operations.js';
import type { AlterAction, MysqlStatement } from '../types/mysql-statements.js';
import type { ParseErrorInfo, PgStatement, PgStatementNode } from '../types/pg-statements.js';

/** What every operation of one statement shares. */
interface OperationBase {
  file: string;
  sql: string;
  dynamic: boolean;
  statementStart: number;
}

/** An operation before its line and column are known. */
type UnplacedOperation = Omit<OperationInit, 'line' | 'column'>;

/** The fields that distinguish one operation of a statement from another. */
type OperationFields = Omit<UnplacedOperation, keyof OperationBase>;

type MysqlOperationFields = OperationFields & { offset?: number };

interface MappedExtraction {
  file: string;
  mapOffset: OffsetMapper;
}

const DATA_STATEMENTS = new Set(['InsertStmt', 'UpdateStmt', 'DeleteStmt', 'SelectStmt', 'CopyStmt', 'MergeStmt']);
const CONSTRAINT_TYPES: Partial<Record<string, ConstraintType>> = {
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

function stringValue(node: PgStatementNode | undefined) {
  return node?.String?.sval ?? null;
}

function lastName(items: PgStatementNode[] | undefined) {
  return stringValue((items ?? []).at(-1));
}

function describeType(typeName: TypeName | undefined): ColumnType | null {
  if (!typeName) return null;
  const name = lastName(typeName.names);
  const modifiers = (typeName.typmods ?? []).map((modifier: PgStatementNode) => modifier.A_Const?.ival?.ival ?? null);
  return { name, modifiers, array: (typeName.arrayBounds ?? []).length > 0 };
}

function constantValue(node: PgStatementNode | undefined) {
  const constant = node?.A_Const;
  if (!constant) return null;
  if (constant.ival) return String(constant.ival.ival ?? 0);
  if (constant.sval) return constant.sval.sval;
  return null;
}

function isLockTimeoutDisabled(args: PgStatementNode[] | undefined) {
  const value = constantValue((args ?? [])[0]);
  return value === '0' || value === '0s' || value === '0ms';
}

function notNullColumnOfCheck(expression: PgStatementNode | undefined) {
  const test = expression?.NullTest;
  if (!test || test.nulltesttype !== 'IS_NOT_NULL') return null;
  const argument: PgStatementNode | undefined = test.arg;
  const fields: PgStatementNode[] = argument?.ColumnRef?.fields ?? [];
  return fields.length === 1 ? stringValue(fields[0]) : null;
}

function describeColumnDefinition(definition: ColumnDef): Omit<OperationFields, 'kind'> {
  const constraints = (definition.constraints ?? []).flatMap((constraint: PgStatementNode) =>
    constraint.Constraint ? [constraint.Constraint] : [],
  );
  const defaultConstraint = constraints.find((constraint) => constraint.contype === 'CONSTR_DEFAULT');
  const type = describeType(definition.typeName);
  return {
    columnName: definition.colname,
    type,
    notNull: constraints.some(
      (constraint) => constraint.contype === 'CONSTR_NOTNULL' || constraint.contype === 'CONSTR_PRIMARY',
    ),
    hasDefault: Boolean(defaultConstraint),
    defaultExpression: defaultConstraint?.raw_expr ?? null,
    identity: constraints.some((constraint) => constraint.contype === 'CONSTR_IDENTITY'),
    generatedStored: constraints.some((constraint) => constraint.contype === 'CONSTR_GENERATED'),
    serial: /^(?:small|big)?serial[248]?$/.test(type?.name ?? ''),
  };
}

function describeConstraint(constraint: Constraint) {
  return {
    constraintType: (constraint.contype && CONSTRAINT_TYPES[constraint.contype]) ?? 'other',
    constraintName: constraint.conname ?? null,
    notValid: Boolean(constraint.skip_validation),
    usingIndex: Boolean(constraint.indexname),
    checkNotNullColumn: constraint.contype === 'CONSTR_CHECK' ? notNullColumnOfCheck(constraint.raw_expr) : null,
  };
}

function alterCommandFields(command: AlterTableCmd): OperationFields {
  const definition: PgStatementNode = command.def ?? {};
  switch (command.subtype) {
    case 'AT_AddColumn': {
      const column = definition.ColumnDef ?? {};
      return { kind: 'add-column', location: column.location, ...describeColumnDefinition(column) };
    }
    case 'AT_AlterColumnType':
      return {
        kind: 'alter-column-type',
        columnName: command.name,
        type: describeType(definition.ColumnDef?.typeName),
        hasUsing: Boolean(definition.ColumnDef?.raw_default),
        location: definition.ColumnDef?.location,
      };
    case 'AT_SetNotNull':
      return { kind: 'set-not-null', columnName: command.name };
    case 'AT_AddConstraint': {
      const constraint = definition.Constraint ?? {};
      return { kind: 'add-constraint', location: constraint.location, ...describeConstraint(constraint) };
    }
    case 'AT_ValidateConstraint':
      return { kind: 'validate-constraint', constraintName: command.name };
    case 'AT_DropConstraint':
      return { kind: 'drop-constraint', constraintName: command.name };
    case 'AT_DropColumn':
      return { kind: 'drop-column', columnName: command.name };
    default:
      return { kind: 'alter-table-other', subtype: command.subtype, columnName: command.name ?? null };
  }
}

function postgresOperations(statement: PgStatement, base: OperationBase): UnplacedOperation[] {
  const node: PgStatementNode = statement.node ?? {};
  const kind = statement.kind ?? '';
  switch (kind) {
    case 'CreateStmt': {
      const body = node.CreateStmt ?? {};
      return [
        {
          ...base,
          kind: 'create-table',
          table: body.relation?.relname,
          columns: (body.tableElts ?? []).flatMap((element: PgStatementNode) =>
            element.ColumnDef
              ? [{ name: element.ColumnDef.colname ?? null, type: describeType(element.ColumnDef.typeName) }]
              : [],
          ),
        },
      ];
    }
    case 'CreateTableAsStmt':
      return [{ ...base, kind: 'create-table', table: node.CreateTableAsStmt?.into?.rel?.relname ?? null }];
    case 'IndexStmt': {
      const body = node.IndexStmt ?? {};
      return [
        {
          ...base,
          kind: 'create-index',
          table: body.relation?.relname,
          index: body.idxname ?? null,
          concurrent: Boolean(body.concurrent),
          unique: Boolean(body.unique),
          // `CREATE INDEX ... ON ONLY parent` cannot be concurrent; it is the documented
          // partitioned-table recipe.
          onlyParent: body.relation?.inh !== true,
        },
      ];
    }
    case 'DropStmt':
      return dropOperations(node.DropStmt ?? {}, base);
    case 'AlterTableStmt': {
      const body = node.AlterTableStmt ?? {};
      if (body.objtype !== 'OBJECT_TABLE') return [{ ...base, kind: 'other' }];
      return (body.cmds ?? []).map((entry: PgStatementNode) => ({
        ...base,
        table: body.relation?.relname,
        ...alterCommandFields(entry.AlterTableCmd ?? {}),
      }));
    }
    case 'RenameStmt':
      return [renameOperation(node.RenameStmt ?? {}, base)];
    case 'TruncateStmt':
      return (node.TruncateStmt?.relations ?? []).map((relation: PgStatementNode) => ({
        ...base,
        kind: 'truncate',
        table: relation.RangeVar?.relname,
      }));
    case 'VariableSetStmt': {
      const body = node.VariableSetStmt ?? {};
      // RESET and SET ... TO DEFAULT restore the server default, which is no timeout.
      if (body.name === 'lock_timeout' && body.kind === 'VAR_SET_VALUE' && !isLockTimeoutDisabled(body.args))
        return [{ ...base, kind: 'set-lock-timeout' }];
      return [{ ...base, kind: 'other' }];
    }
    case 'TransactionStmt':
      return [transactionOperation(node.TransactionStmt ?? {}, base)];
    case 'VacuumStmt': {
      const body = node.VacuumStmt ?? {};
      return (body.options ?? []).some((option: PgStatementNode) => option.DefElem?.defname === 'full')
        ? [{ ...base, kind: 'table-rewrite-command', command: 'VACUUM FULL', table: vacuumTable(body) }]
        : [{ ...base, kind: 'other' }];
    }
    case 'ClusterStmt':
      return [
        {
          ...base,
          kind: 'table-rewrite-command',
          command: 'CLUSTER',
          table: node.ClusterStmt?.relation?.relname ?? null,
        },
      ];
    case 'ReindexStmt': {
      const body = node.ReindexStmt ?? {};
      return [
        {
          ...base,
          kind: 'table-rewrite-command',
          command: 'REINDEX',
          table: body.relation?.relname ?? null,
          concurrent: (body.params ?? []).some(
            (parameter: PgStatementNode) => parameter.DefElem?.defname === 'concurrently',
          ),
        },
      ];
    }
    case 'CreateTrigStmt':
      return [
        {
          ...base,
          kind: 'alter-table-other',
          table: node.CreateTrigStmt?.relation?.relname ?? null,
          subtype: 'trigger',
        },
      ];
    default:
      if (kind === 'SelectStmt' && SET_CONFIG_LOCK_TIMEOUT.test(statement.text))
        return [{ ...base, kind: 'set-lock-timeout' }];
      return [{ ...base, kind: DATA_STATEMENTS.has(kind) ? 'data' : 'other' }];
  }
}

function vacuumTable(body: VacuumStmt) {
  const [first]: PgStatementNode[] = body.rels ?? [];
  return first?.VacuumRelation?.relation?.relname ?? null;
}

function dropOperations(body: DropStmt, base: OperationBase): UnplacedOperation[] {
  const objects: PgStatementNode[] = body.objects ?? [];
  if (body.removeType === 'OBJECT_TABLE') {
    return objects.map((object) => ({ ...base, kind: 'drop-table', table: lastName(object.List?.items) }));
  }
  if (body.removeType === 'OBJECT_INDEX') {
    return [
      {
        ...base,
        kind: 'drop-index',
        concurrent: Boolean(body.concurrent),
        index: lastName(objects[0]?.List?.items),
      },
    ];
  }
  return [{ ...base, kind: 'other' }];
}

function renameOperation(body: RenameStmt, base: OperationBase): UnplacedOperation {
  if (body.renameType === 'OBJECT_TABCONSTRAINT') {
    return {
      ...base,
      kind: 'rename-constraint',
      table: body.relation?.relname,
      constraintName: body.subname,
      newName: body.newname,
    };
  }
  if (body.renameType === 'OBJECT_COLUMN' && body.relationType === 'OBJECT_TABLE') {
    return {
      ...base,
      kind: 'rename-column',
      table: body.relation?.relname,
      columnName: body.subname,
      newName: body.newname,
    };
  }
  if (body.renameType === 'OBJECT_TABLE') {
    return { ...base, kind: 'rename-table', table: body.relation?.relname, newName: body.newname };
  }
  return { ...base, kind: 'other' };
}

function transactionOperation(body: TransactionStmt, base: OperationBase): UnplacedOperation {
  if (body.kind === 'TRANS_STMT_BEGIN' || body.kind === 'TRANS_STMT_START')
    return { ...base, kind: 'transaction-begin' };
  if (body.kind === 'TRANS_STMT_COMMIT' || body.kind === 'TRANS_STMT_ROLLBACK')
    return { ...base, kind: 'transaction-end' };
  return { ...base, kind: 'other' };
}

function lineStartsOf(text: string) {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') starts.push(index + 1);
  return starts;
}

// `mapOffset` turns a character offset in `sqlText` into a file position; .sql files map 1:1, query
// literals do not.
function defaultMapper(sqlText: string): OffsetMapper {
  const index = createPositionIndex(sqlText);
  return (offset: number) => index.fromCharOffset(offset);
}

const UNLOCATED_COMMAND_KINDS = new Set([
  'drop-column',
  'set-not-null',
  'validate-constraint',
  'drop-constraint',
  'alter-table-other',
]);

function escapeRegExp(text: string) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Offset of identifier `name` (quoted exactly, or unquoted case-insensitively) at or after `from`,
// else -1.
function findName(text: string, name: string, from: number) {
  const pattern = new RegExp(
    `"${escapeRegExp(name.replaceAll('"', '""'))}"|(?<![\\w$"])${escapeRegExp(name)}(?![\\w$"])`,
    'gi',
  );
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match ? match.index : -1;
}

function extractPostgres(sqlText: string, { file, mapOffset }: MappedExtraction): SqlExtraction {
  const lineStarts = lineStartsOf(sqlText);
  const operations: MigrationOperation[] = [];
  const statements = pgParser.parseStatements(sqlText);
  for (const statement of statements) {
    const statementIndex = createPositionIndex(statement.text);
    const relation = statement.node?.AlterTableStmt?.relation;
    let cursor = relation
      ? statementIndex.byteToCharOffset(relation.location ?? 0) + (relation.relname ?? '').length
      : 0;
    // Sub-commands without a parser location (DROP COLUMN, SET NOT NULL, ...) are placed at their
    // name.
    const commandOffset = (location: number | undefined, fields: OperationFields) => {
      if (location !== undefined && Number.isInteger(location) && location >= 0) {
        cursor = statementIndex.byteToCharOffset(location);
        return statement.start + cursor;
      }
      const name = UNLOCATED_COMMAND_KINDS.has(fields.kind) ? (fields.columnName ?? fields.constraintName) : null;
      const found = name ? findName(statement.text, name, cursor) : -1;
      if (found === -1) return statement.start;
      cursor = found + 1;
      return statement.start + found;
    };
    const base: OperationBase = {
      file,
      sql: statement.text,
      dynamic: containsPlaceholder(statement.text),
      statementStart: statement.start,
    };
    const fields: UnplacedOperation[] = statement.error
      ? [{ ...base, kind: 'unparsed', parseError: statement.error }]
      : postgresOperations(statement, base);
    for (const { location, ...operationFields } of fields) {
      const position = mapOffset(commandOffset(location, operationFields));
      if (operationFields.parseError) {
        const { line, column }: ParseErrorInfo = operationFields.parseError;
        const errorOffset = (lineStarts[line - 1] ?? 0) + column - 1;
        operationFields.parseError = { ...operationFields.parseError, ...mapOffset(errorOffset) };
      }
      operations.push(createOperation({ ...operationFields, ...position }));
    }
  }
  return { operations, statementCount: statements.length };
}

function mysqlActionFields(action: AlterAction): OperationFields[] {
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
      const change: OperationFields = { kind: 'alter-column-type', columnName: action.newName ?? action.column };
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

function mysqlStatementFields(statement: MysqlStatement): MysqlOperationFields[] {
  const options = {
    algorithm: 'algorithm' in statement ? statement.algorithm : null,
    lock: 'lock' in statement ? statement.lock : null,
  };
  switch (statement.kind) {
    case 'alter-table':
      return statement.actions.flatMap((action) =>
        mysqlActionFields(action).map((fields) => ({
          table: statement.table,
          ...options,
          ...fields,
          offset: action.start,
        })),
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

function otherMysqlFields(text: string): OperationFields {
  const created = MYSQL_CREATE_TABLE.exec(text);
  if (created) return { kind: 'create-table', table: created[1] };
  // MySQL commits implicitly around DDL, so transactions only matter for data statements; they are
  // tracked anyway.
  if (MYSQL_TRANSACTION_START.test(text)) return { kind: 'transaction-begin' };
  if (MYSQL_TRANSACTION_END.test(text)) return { kind: 'transaction-end' };
  return { kind: MYSQL_DATA.test(text) ? 'data' : 'other' };
}

function extractMysql(sqlText: string, { file, mapOffset }: MappedExtraction): SqlExtraction {
  const operations: MigrationOperation[] = [];
  const statements = parseMysqlStatements(sqlText);
  for (const statement of statements) {
    const base = {
      file,
      sql: statement.text,
      dynamic: containsPlaceholder(statement.text),
      statementStart: statement.start,
      statementKind: statement.kind,
    };
    for (const { offset = statement.start, ...fields } of mysqlStatementFields(statement)) {
      operations.push(createOperation({ ...base, ...fields, ...mapOffset(offset) }));
    }
  }
  return { operations, statementCount: statements.length };
}

// Postgres parsing needs the WASM module; callers await this once before extracting.
async function prepareDialect(dialect: MigrationDialect) {
  if (dialect === 'postgres') await pgParser.ensureLoaded();
}

function extractSqlText(sqlText: string, { dialect, file, mapOffset }: SqlExtractionOptions): SqlExtraction {
  const text = sqlText.charCodeAt(0) === 0xfeff ? sqlText.slice(1) : sqlText;
  const mapper = mapOffset ?? defaultMapper(text);
  if (dialect === 'mysql') return extractMysql(text, { file, mapOffset: mapper });
  return extractPostgres(text, { file, mapOffset: mapper });
}

// Prisma sends a multi-statement file as one implicit transaction; the Drizzle migrator wraps every
// file in one.
function sqlFileInTransaction(framework: string, statementCount: number) {
  if (framework === 'prisma') return statementCount > 1;
  return framework === 'drizzle';
}

export { prepareDialect, extractSqlText, sqlFileInTransaction };
