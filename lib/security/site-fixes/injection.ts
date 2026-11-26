// Rule id -> build({ finding, node, sourceFile, text, load }) => { edits, note } | undefined; see
// lib/performance/site-fix.js.
import { ts, textOf, replaceNode, requireReview, calleeCall } from '../../performance/site-fixes/helpers.js';
import type { Node, PropertyAssignment, ShorthandPropertyAssignment, SourceFile, TemplateExpression } from 'typescript';
import type { FixResult, SiteFixBuilder, SiteFixInput } from '../../shared/types.js';

const equalityNote =
  '`$eq` matches the value literally, so an object sent by a caller no longer acts as query operators. A scalar value matches exactly as before.';

function filterProperty(
  node: Node,
  sourceFile: SourceFile,
): PropertyAssignment | ShorthandPropertyAssignment | undefined {
  for (let current: Node = node; current?.parent; current = current.parent) {
    const parent = current.parent;
    if (ts.isPropertyAssignment(parent) && parent.initializer === current) return parent;
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === current) return parent;
    if (parent.getStart(sourceFile) !== current.getStart(sourceFile)) return;
  }
}

function wrapInEquality({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  const property = node && sourceFile && filterProperty(node, sourceFile);
  if (!property || !ts.isObjectLiteralExpression(property.parent)) return;
  if (textOf(property.name).replaceAll(/['"]/g, '').startsWith('$')) return;
  if (ts.isShorthandPropertyAssignment(property)) {
    const name = textOf(property.name);
    return { edits: [replaceNode(property, `${name}: { $eq: ${name} }`)], note: equalityNote };
  }
  return { edits: [replaceNode(property.initializer, `{ $eq: ${textOf(property.initializer)} }`)], note: equalityNote };
}

function regexFromInputFix({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const newExpr = ts.findAncestor(node, ts.isNewExpression);
  const callExpr = newExpr ?? calleeCall(node);
  if (!callExpr || !callExpr.arguments?.length) return;
  const patternArg = callExpr.arguments[0];
  if (ts.isStringLiteralLike(patternArg) || ts.isRegularExpressionLiteral(patternArg)) return;
  const exprText = patternArg.getText(sourceFile);
  return {
    edits: [replaceNode(patternArg, `(${exprText}).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')`)],
    note: 'Escapes RegExp metacharacters in the dynamic pattern.',
  };
}

function parameterizeTemplate(
  template: TemplateExpression,
  sourceFile: SourceFile,
  placeholderFor: (index: number) => string,
): { sql: string; params: string[] } | undefined {
  let sql = template.head.text;
  const params: string[] = [];
  for (let index = 0; index < template.templateSpans.length; index++) {
    const span = template.templateSpans[index];
    sql += placeholderFor(index + 1) + span.literal.text;
    params.push(span.expression.getText(sourceFile));
  }
  if (!params.length) return;
  return { sql: JSON.stringify(sql), params };
}

function sqlParameterizeFix(
  { node, sourceFile }: SiteFixInput,
  placeholderFor: (index: number) => string,
  note: string,
): FixResult | undefined {
  if (!node || !sourceFile) return;
  const call = calleeCall(node);
  if (!call || call.arguments.length !== 1) return;
  const arg = ts.skipOuterExpressions(call.arguments[0]);
  if (!ts.isTemplateExpression(arg)) return;
  const parameterized = parameterizeTemplate(arg, sourceFile, placeholderFor);
  if (!parameterized) return;
  return {
    edits: [replaceNode(arg, `${parameterized.sql}, [${parameterized.params.join(', ')}]`)],
    note,
  };
}

function prismaRawSafeFix({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const call = calleeCall(node);
  if (!call || call.arguments.length !== 1) return;
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return;
  const method = callee.name.text;
  if (method !== '$queryRawUnsafe' && method !== '$executeRawUnsafe') return;
  const arg = ts.skipOuterExpressions(call.arguments[0]);
  if (!ts.isTemplateExpression(arg)) return;
  const safeMethod = method === '$queryRawUnsafe' ? '$queryRaw' : '$executeRaw';
  return {
    edits: [replaceNode(call, `${callee.expression.getText(sourceFile)}.${safeMethod}${arg.getText(sourceFile)}`)],
    note: 'Replaces `$queryRawUnsafe` / `$executeRawUnsafe` with a tagged template literal so Prisma parameterizes interpolated values.',
  };
}

const builders: Record<string, SiteFixBuilder> = {
  'nosql-operator-injection': requireReview(
    'A caller that sends query operators in this field now matches nothing, so intended operator use breaks.',
    wrapInEquality,
  ),
  'regex-from-input': regexFromInputFix,
  'mysql-dynamic-query-text': requireReview(
    'Verify interpolated expressions are column values rather than SQL identifiers or keywords.',
    (input) => sqlParameterizeFix(input, () => '?', 'Parameterizes template interpolations with `?` placeholders.'),
  ),
  'prisma-raw-unsafe-dynamic': requireReview(
    'Verify interpolated expressions are SQL values rather than table or column identifiers.',
    prismaRawSafeFix,
  ),
};

export default builders;
