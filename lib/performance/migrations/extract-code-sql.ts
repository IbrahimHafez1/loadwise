import ts from 'typescript';
import * as pgParser from '../sql/pg-parser.js';
import { DYNAMIC_PLACEHOLDER_PREFIX } from './operations.js';
import type { Node as PgNode } from '@pgsql/types';
import type { CallExpression, Expression, Identifier, Node, SourceFile } from 'typescript';
import type { OffsetMapper } from '../types/migration-extraction.js';
import type { MigrationDialect } from '../types/migration-operations.js';
import type { PgStatementNode } from '../types/pg-statements.js';
import type { SourcePosition } from '../types/source-position.js';
import { findDeclaration, isFunctionLike, objectProperty, unwrapExpression } from './extract-code-discovery.js';
import type {
  Bindings,
  BuilderDefault,
  BuilderFields,
  CallParts,
  CodeOperation,
  SqlBuilder,
} from './extract-code-types.js';

export const MIKRO_ORM_SQL_METHODS = new Set(['addSql', 'execute']);

const CLIENT_SIDE_DEFAULTS = /\b(?:UUIDV4|UUIDV1)\b/;

export const EMPTY_BINDINGS: Bindings = new Map();

// A helper parameter resolves to its call-site argument; any other name to its `const` declaration.
function resolveIdentifierSql(
  identifier: Identifier,
  sourceFile: SourceFile,
  depth: number,
  bindings: Bindings,
): SqlBuilder | null {
  const bound = bindings.get(identifier.text);
  if (bound) return bound.node ? sqlFromExpression(bound.node, sourceFile, depth + 1, bound.bindings) : null;
  const declared = findDeclaration(identifier, identifier.text);
  return declared && !isFunctionLike(declared) ? sqlFromExpression(declared, sourceFile, depth + 1, bindings) : null;
}

// Builds SQL text plus segments mapping SQL offsets back to the file. Holes become placeholders.
export function sqlFromExpression(
  node: Node,
  sourceFile: SourceFile,
  depth = 0,
  bindings: Bindings = EMPTY_BINDINGS,
): SqlBuilder | null {
  const expression = unwrapExpression(node);
  const builder: SqlBuilder = { sql: '', segments: [], dynamic: false, holes: 0, literalText: '' };
  const appendLiteral = (cooked: string, raw: string, fileStart: number) => {
    builder.literalText += cooked;
    builder.segments.push({ sqlStart: builder.sql.length, length: cooked.length, fileStart, exact: cooked === raw });
    builder.sql += cooked;
  };
  const appendHole = (hole: Node) => {
    const placeholder = DYNAMIC_PLACEHOLDER_PREFIX + builder.holes++;
    builder.segments.push({
      sqlStart: builder.sql.length,
      length: placeholder.length,
      fileStart: hole.getStart(sourceFile),
      exact: false,
    });
    builder.sql += placeholder;
    builder.dynamic = true;
  };
  // `${name}` naming a constant string (or a helper parameter given one) is spliced in, placed at
  // the hole.
  const appendTemplateHole = (hole: Expression) => {
    const value = unwrapExpression(hole);
    const resolved =
      ts.isIdentifier(value) && depth < 3 ? resolveIdentifierSql(value, sourceFile, depth, bindings) : null;
    if (!resolved || resolved.dynamic) return appendHole(hole);
    builder.literalText += resolved.sql;
    builder.segments.push({
      sqlStart: builder.sql.length,
      length: resolved.sql.length,
      fileStart: hole.getStart(sourceFile),
      exact: false,
    });
    builder.sql += resolved.sql;
  };
  const append = (part: Node): void => {
    const value = unwrapExpression(part);
    if (ts.isStringLiteral(value)) {
      const start = value.getStart(sourceFile) + 1;
      appendLiteral(value.text, sourceFile.text.slice(start, value.end - 1), start);
    } else if (ts.isNoSubstitutionTemplateLiteral(value)) {
      appendLiteral(value.text, value.rawText ?? value.text, value.getStart(sourceFile) + 1);
    } else if (ts.isNumericLiteral(value)) {
      appendLiteral(value.text, value.getText(sourceFile), value.getStart(sourceFile));
    } else if (ts.isTemplateExpression(value)) {
      appendLiteral(value.head.text, value.head.rawText ?? value.head.text, value.head.getStart(sourceFile) + 1);
      for (const span of value.templateSpans) {
        appendTemplateHole(span.expression);
        appendLiteral(
          span.literal.text,
          span.literal.rawText ?? span.literal.text,
          span.literal.getStart(sourceFile) + 1,
        );
      }
    } else if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      append(value.left);
      append(value.right);
    } else if (ts.isIdentifier(value) && depth < 3) {
      const resolved = resolveIdentifierSql(value, sourceFile, depth, bindings);
      if (!resolved) appendHole(value);
      else {
        const offset = builder.sql.length;
        builder.segments.push(
          ...resolved.segments.map((segment) => ({ ...segment, sqlStart: segment.sqlStart + offset })),
        );
        builder.sql += resolved.sql;
        builder.dynamic ||= resolved.dynamic;
        builder.literalText += resolved.literalText;
      }
    } else appendHole(value);
  };
  append(expression);
  // A call whose text is entirely interpolated says nothing about its statement.
  return builder.literalText.trim() ? builder : null;
}

export function offsetMapper(builder: SqlBuilder, sourceFile: SourceFile): OffsetMapper {
  return (sqlOffset: number) => {
    let segment = builder.segments[0];
    for (const candidate of builder.segments) {
      if (candidate.sqlStart <= sqlOffset) segment = candidate;
      else break;
    }
    const fileOffset = segment.exact
      ? segment.fileStart + Math.min(sqlOffset - segment.sqlStart, segment.length)
      : segment.fileStart;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(fileOffset);
    return { line: line + 1, column: character + 1 };
  };
}

export function positionOf(node: Node, sourceFile: SourceFile): SourcePosition {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

export function calleeParts(call: CallExpression): CallParts | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  return { method: callee.name.text, receiver: callee.expression };
}

export function receiverName(receiver: Node, sourceFile: SourceFile) {
  return receiver.getText(sourceFile);
}

export function stringArgument(node: Node | undefined): string | null {
  const value = unwrapExpression(node);
  if (!value) return null;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isObjectLiteralExpression(value)) {
    const tableName = objectProperty(value, 'tableName')?.initializer;
    return tableName ? stringArgument(tableName) : null;
  }
  return null;
}

export function tableArgument(node: Node | undefined) {
  const value = unwrapExpression(node);
  if (value && ts.isNewExpression(value))
    return stringArgument(objectProperty(value.arguments?.[0], 'name')?.initializer);
  return stringArgument(value);
}

export function isInsideTransactionCallback(node: Node, upFunction: Node) {
  for (let current: Node | undefined = node.parent; current && current !== upFunction; current = current.parent) {
    if (!isFunctionLike(current) || !ts.isCallExpression(current.parent)) continue;
    const parts = calleeParts(current.parent);
    if (parts?.method === 'transaction') return true;
  }
  return false;
}

// Parses a raw SQL default (TypeORM `default`, `Sequelize.literal`, `knex.raw`) into an expression
// node.
export function parseDefaultSql(text: string): PgNode | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const [statement] = pgParser.parseStatements('SELECT ' + text);
    const [target]: PgStatementNode[] = statement?.node?.SelectStmt?.targetList ?? [];
    return target?.ResTarget?.val ?? null;
  } catch {
    return null;
  }
}

export function functionCallDefault(name: string): PgNode {
  return { FuncCall: { funcname: [{ String: { sval: name } }] } };
}

// Default described by a schema-builder value: { hasDefault, defaultExpression }.
export function describeBuilderDefault(
  node: Node | undefined,
  sourceFile: SourceFile,
  dialect: MigrationDialect,
): BuilderDefault {
  const value = unwrapExpression(node);
  if (!value) return { hasDefault: false, defaultExpression: null };
  const text = value.getText(sourceFile);
  if (CLIENT_SIDE_DEFAULTS.test(text)) return { hasDefault: false, defaultExpression: null };
  if (ts.isCallExpression(value)) {
    const parts = calleeParts(value);
    const firstArgument = stringArgument(value.arguments[0]);
    if (parts && ['literal', 'raw'].includes(parts.method) && firstArgument !== null) {
      return { hasDefault: true, defaultExpression: dialect === 'postgres' ? parseDefaultSql(firstArgument) : null };
    }
    if (parts?.method === 'fn' && firstArgument)
      return { hasDefault: true, defaultExpression: functionCallDefault(firstArgument) };
    if (parts?.method === 'now') return { hasDefault: true, defaultExpression: functionCallDefault('now') };
    if (parts?.method === 'uuid')
      return { hasDefault: true, defaultExpression: functionCallDefault('gen_random_uuid') };
  }
  if (/\bNOW\b/.test(text) && ts.isPropertyAccessExpression(value)) {
    return { hasDefault: true, defaultExpression: functionCallDefault('now') };
  }
  return { hasDefault: true, defaultExpression: null };
}

export function builderOperation(call: CallExpression, sourceFile: SourceFile, fields: BuilderFields): CodeOperation {
  return { ...positionOf(call, sourceFile), sql: call.getText(sourceFile), builder: true, ...fields };
}
