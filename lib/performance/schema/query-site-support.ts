import { ts } from '../compiler.js';
import type { Expression, Node, PropertyAssignment, ShorthandPropertyAssignment } from 'typescript';
import type { CheckerAdapter, TypeAdapter } from '../../shared/types.js';
import type { ConditionKind, QuerySite } from '../types/query-site.js';
import type { SchemaOrm, SchemaTable } from '../types/schema-model.js';

export type ConditionProperty = PropertyAssignment | ShorthandPropertyAssignment;

export interface ConditionTarget {
  site: QuerySite;
  table: SchemaTable;
  column: string;
  kind: ConditionKind;
  node: Node;
}

export interface ConditionExtra {
  operator?: string;
  expression?: string;
  insensitive?: boolean;
}

const scalarFlags: (keyof typeof ts.TypeFlags)[] = [
  'StringLike',
  'NumberLike',
  'BooleanLike',
  'BigIntLike',
  'EnumLike',
  'Null',
  'Undefined',
  'Void',
];

export function newSite(orm: SchemaOrm, node: Node): QuerySite {
  return { orm, node, conditions: [], order: undefined, limited: false, uncertain: false };
}

export function unwrap(node: Expression): Expression;
export function unwrap(node: Expression | undefined): Expression | undefined;
export function unwrap(node: Expression | undefined): Expression | undefined {
  return node && ts.skipOuterExpressions(node);
}

export function isScalarType(type: TypeAdapter): boolean {
  if (type.isUnion()) return (type.types ?? []).every(isScalarType);
  if (scalarFlags.some((flag) => type.flags & ts.TypeFlags[flag])) return true;
  return type.getSymbol()?.name === 'Date';
}

// A value compared by equality: a literal, or an expression whose type is a primitive or a Date.
export function isScalarValue(node: Expression, checker: CheckerAdapter): boolean {
  const value = unwrap(node);
  if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) || ts.isTemplateExpression(value)) return true;
  if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)) return false;
  return isScalarType(checker.getTypeAtLocation(value));
}

export function isNullLiteral(node: Expression | undefined): boolean {
  return unwrap(node)?.kind === ts.SyntaxKind.NullKeyword;
}

export function literalText(node: Expression | undefined): string | undefined {
  const value = unwrap(node);
  if (!value) return;
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isTemplateExpression(value)) return value.head.text + '…';
}

// `'%term'`, `` `%${term}%` `` -> true; a pattern whose start is unknown -> undefined.
export function leadingWildcard(node: Expression | undefined): boolean | undefined {
  const text = literalText(node);
  if (text === undefined) return;
  return text.startsWith('%') || text.startsWith('_');
}

export function addCondition({ site, table, column, kind, node }: ConditionTarget, extra?: ConditionExtra): void {
  if (!table.columns.has(column)) {
    site.uncertain = true;
    return;
  }
  site.conditions.push({ table, column, kind, node, ...extra });
}

export interface FieldTarget {
  site: QuerySite;
  table: SchemaTable;
  column: string;
  node: Node;
}
