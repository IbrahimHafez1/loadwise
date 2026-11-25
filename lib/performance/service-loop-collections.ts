import { ts, isDefaultLibrary } from './compiler.js';
import { elementBinding, isStandardArrayCall, outerExpression } from './repeated.js';
import { isBatchCollection, isGrownLater } from './query-loops.js';
import { packageOf, resolvedSymbol } from './schema/ts-helpers.js';
import { typeormImportOf } from './orm-owners.js';
import { isProjectFunction, methodName, operationFamily, signatureDeclaration } from './service-call-resolution.js';
import type { CallExpression, EnumDeclaration, Expression, ForStatement, Node } from 'typescript';
import type { CheckerAdapter } from '../shared/types.js';
import type { FunctionWithBody } from '../shared/types/function-summaries.js';
import type { RepeatOwner } from './types/repeat-owner.js';

const MAX_CONSTANT_DEPTH = 6;
// `list.slice(0, 2)` keeps a handful of items whatever the list holds.
const MAX_SLICED_ITEMS = 5;
// Output arguments are followed this many calls deep to find where they are appended to.
const MAX_FORWARDING_DEPTH = 3;
const appendingMethods = new Set(['push', 'unshift', 'splice']);
const objectReaders = new Set(['keys', 'values', 'entries']);
const arrayNarrowers = new Set(['filter', 'slice', 'map']);
const listOperators = new Set(['in', '$in']);

const literalFlags =
  ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.EnumLiteral;

function isArrayValue(node: Node, checker: CheckerAdapter): boolean {
  const symbol = checker.getTypeAtLocation(node).getSymbol();
  return (
    (symbol?.name === 'Array' || symbol?.name === 'ReadonlyArray') &&
    !!symbol.declarations?.some((declaration) => isDefaultLibrary(checker, declaration.getSourceFile()))
  );
}

// `{ in: ids }`, Mongo's `{ _id: { $in: ids } }` or TypeORM's `{ where: { id: In(ids) } }` hands
// the callee a whole key set; a relation filter such as `{ where: { folder: { id: In(ids) } } }`
// nests one level deeper.
function carriesInList(argument: Expression, checker: CheckerAdapter, depth = 0): boolean {
  const value = ts.skipOuterExpressions(argument);
  if (depth > 2 || !ts.isObjectLiteralExpression(value)) return false;
  return value.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ((!ts.isComputedPropertyName(property.name) &&
        listOperators.has(property.name.text) &&
        isArrayValue(property.initializer, checker)) ||
        isTypeormInList(property.initializer, checker) ||
        carriesInList(property.initializer, checker, depth + 1)),
  );
}

function isTypeormInList(expression: Expression, checker: CheckerAdapter): boolean {
  const value = ts.skipOuterExpressions(expression);
  if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression) || value.arguments.length !== 1) return false;
  return typeormImportOf(value.expression, checker) === 'In' && isArrayValue(value.arguments[0], checker);
}

// A list the callee appends to, such as `warnings` or a lookup cache, is an output rather than a
// key batch.
function appendsTo(declaration: FunctionWithBody, name: string, checker: CheckerAdapter, depth = 0): boolean {
  if (depth > MAX_FORWARDING_DEPTH) return false;
  return !!(function visit(node: Node): true | undefined {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        appendingMethods.has(callee.name.text) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === name
      )
        return true;
      const index = node.arguments.findIndex((argument) => ts.isIdentifier(argument) && argument.text === name);
      const target = index >= 0 ? signatureDeclaration(node, checker) : undefined;
      if (isProjectFunction(target)) {
        const parameter = target.parameters[index];
        if (parameter && ts.isIdentifier(parameter.name) && appendsTo(target, parameter.name.text, checker, depth + 1))
          return true;
      }
    }
    return ts.forEachChild(node, visit);
  })(declaration.body);
}

function isDrizzleBatchFilter(argument: Expression, owner: RepeatOwner, checker: CheckerAdapter): boolean {
  if (!ts.isCallExpression(argument)) return false;
  const symbol = resolvedSymbol(argument.expression, checker);
  if (!symbol?.declarations?.some((item) => packageOf(item) === 'drizzle-orm')) return false;
  if (symbol.name === 'inArray')
    return argument.arguments.length === 2 && isBatchCollection(argument.arguments[1], owner, checker);
  return symbol.name === 'and' && argument.arguments.some((term) => isDrizzleBatchFilter(term, owner, checker));
}

function usesSqlFilter(declaration: FunctionWithBody, checker: CheckerAdapter): boolean {
  const parameter = declaration.parameters[0]?.name;
  if (!parameter || !ts.isIdentifier(parameter)) return false;
  const binding = checker.getSymbolAtLocation(parameter);
  if (!binding) return false;
  function visit(node: Node): boolean | undefined {
    if (ts.isFunctionLike(node)) return false;
    if (ts.isCallExpression(node) && methodName(node) === 'execute' && node.arguments.length === 1) {
      const query = node.arguments[0];
      if (!ts.isTaggedTemplateExpression(query) || !ts.isTemplateExpression(query.template)) return false;
      const tag = resolvedSymbol(query.tag, checker);
      const execute = signatureDeclaration(node, checker);
      if (
        tag?.name === 'sql' &&
        execute &&
        operationFamily('execute', execute) === 'drizzle' &&
        tag.declarations?.some((item) => packageOf(item) === 'drizzle-orm')
      ) {
        const spans = query.template.templateSpans;
        const predicate = spans.at(-1);
        const precedingSql = spans.at(-2)?.literal.text ?? query.template.head.text;
        return (
          predicate !== undefined &&
          /\bWHERE\s*$/i.test(precedingSql) &&
          /^\s*;?\s*$/.test(predicate.literal.text) &&
          checker.getSymbolAtLocation(predicate.expression) === binding
        );
      }
    }
    return ts.forEachChild(node, (child) => visit(child) || undefined);
  }
  return !!visit(declaration.body);
}

// A callee that takes the item keys as a list is already a batch API called per group.
function passesCollection(
  call: CallExpression,
  declaration: FunctionWithBody,
  owner: RepeatOwner,
  checker: CheckerAdapter,
): boolean {
  return call.arguments.some((argument, index) => {
    if (carriesInList(argument, checker)) return true;
    if (
      call.arguments.length === 1 &&
      isDrizzleBatchFilter(argument, owner, checker) &&
      usesSqlFilter(declaration, checker)
    )
      return true;
    if (!isArrayValue(argument, checker)) return false;
    const parameter = declaration.parameters[index];
    return (
      !parameter ||
      !!parameter.dotDotDotToken ||
      !ts.isIdentifier(parameter.name) ||
      !appendsTo(declaration, parameter.name.text, checker)
    );
  });
}

function lengthBoundCollection(loop: ForStatement): Expression | undefined {
  const condition = loop.condition && ts.skipOuterExpressions(loop.condition);
  if (
    condition &&
    ts.isBinaryExpression(condition) &&
    (condition.operatorToken.kind === ts.SyntaxKind.LessThanToken ||
      condition.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken) &&
    ts.isPropertyAccessExpression(condition.right) &&
    condition.right.name.text === 'length'
  )
    return condition.right.expression;
}

// The collection a per-item loop walks; undefined for retry, polling and queue-draining loops.
function iteratedCollection(owner: RepeatOwner): Expression | undefined {
  if (ts.isForOfStatement(owner) || ts.isForInStatement(owner)) return owner.expression;
  if (ts.isForStatement(owner)) return lengthBoundCollection(owner);
  if (!ts.isFunctionLike(owner)) return;
  const call = outerExpression(owner).parent;
  if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) return call.expression.expression;
}

function constantInitializer(
  expression: Expression,
  checker: CheckerAdapter,
): Expression | EnumDeclaration | undefined {
  const value = ts.skipOuterExpressions(expression);
  if (!ts.isIdentifier(value)) return;
  const declaration = resolvedSymbol(value, checker)?.valueDeclaration;
  if (declaration && ts.isEnumDeclaration(declaration)) return declaration;
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.parent.flags & ts.NodeFlags.Const &&
    declaration.initializer
  )
    return ts.skipOuterExpressions(declaration.initializer);
}

function isConstantTable(expression: Expression, checker: CheckerAdapter, depth: number): boolean {
  const table = constantInitializer(expression, checker);
  if (table && ts.isEnumDeclaration(table)) return true;
  return (
    !!table &&
    ts.isObjectLiteralExpression(table) &&
    table.properties.length > 0 &&
    table.properties.every(
      (property) => ts.isPropertyAssignment(property) && isConstantCollection(property.initializer, checker, depth + 1),
    )
  );
}

// Lists written into the source, such as fallback chains or enum values, have a size fixed by the
// code.
function isConstantCollection(expression: Expression | undefined, checker: CheckerAdapter, depth = 0): boolean {
  if (!expression || depth > MAX_CONSTANT_DEPTH) return false;
  const value = ts.skipOuterExpressions(expression);
  const follow = (child: Expression | undefined): boolean => isConstantCollection(child, checker, depth + 1);
  if (ts.isArrayLiteralExpression(value))
    return (
      value.elements.length > 0 &&
      value.elements.every((element) => !ts.isSpreadElement(element) || follow(element.expression))
    );
  if (ts.isConditionalExpression(value)) return follow(value.whenTrue) && follow(value.whenFalse);
  // `await Promise.all(pair.map(load))` has as many items as the pair.
  if (ts.isAwaitExpression(value)) return follow(value.expression);
  if (ts.isIdentifier(value)) {
    // A work queue seeded from a literal, such as a tree walk, keeps growing while the loop runs.
    const declaration = resolvedSymbol(value, checker)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && isGrownLater(declaration, checker)) return false;
    const initializer = constantInitializer(value, checker);
    return initializer !== undefined && !ts.isEnumDeclaration(initializer) && follow(initializer);
  }
  if (ts.isElementAccessExpression(value) || ts.isPropertyAccessExpression(value))
    return isConstantTable(value.expression, checker, depth);
  if (!ts.isCallExpression(value)) return false;
  if (!ts.isPropertyAccessExpression(value.expression)) return returnsConstantCollection(value, checker, depth);
  const method = value.expression.name.text;
  const receiver = ts.skipOuterExpressions(value.expression.expression);
  if (ts.isIdentifier(receiver) && receiver.text === 'Object' && objectReaders.has(method))
    return value.arguments.length === 1 && isConstantObject(value.arguments[0], checker);
  if (ts.isIdentifier(receiver) && receiver.text === 'Promise' && method === 'all')
    return value.arguments.length === 1 && follow(value.arguments[0]);
  if (method === 'slice' && isStandardArrayCall(value, checker) && slicesFewItems(value, checker)) return true;
  if (arrayNarrowers.has(method) && isStandardArrayCall(value, checker)) return follow(receiver);
  return returnsConstantCollection(value, checker, depth);
}

function slicesFewItems(call: CallExpression, checker: CheckerAdapter): boolean {
  const [start, end] = call.arguments.map((argument) => argument && ts.skipOuterExpressions(argument));
  return !!start && !!end && ts.isNumericLiteral(start) && Number(start.text) === 0 && isFewItems(end, checker);
}

// A literal, or a constant such as an imported `BATCH_SIZE = 4`, whose type is that number.
function isFewItems(end: Expression, checker: CheckerAdapter): boolean {
  if (ts.isNumericLiteral(end)) return Number(end.text) <= MAX_SLICED_ITEMS;
  const type = checker.getTypeAtLocation(end);
  return (
    !!(type.flags & ts.TypeFlags.NumberLiteral) && typeof type.value === 'number' && type.value <= MAX_SLICED_ITEMS
  );
}

function isConstantObject(expression: Expression, checker: CheckerAdapter): boolean {
  const table = constantInitializer(expression, checker);
  return (
    !!table &&
    (ts.isEnumDeclaration(table) ||
      (ts.isObjectLiteralExpression(table) && !table.properties.some(ts.isSpreadAssignment)))
  );
}

// A project helper such as `selectSources()` that only returns a filtered constant list.
function returnsConstantCollection(call: CallExpression, checker: CheckerAdapter, depth: number): boolean {
  const declaration = signatureDeclaration(call, checker);
  if (!isProjectFunction(declaration) || !ts.isBlock(declaration.body)) return false;
  const results: (Expression | undefined)[] = [];
  (function visit(node: Node): void {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) results.push(node.expression);
    ts.forEachChild(node, visit);
  })(declaration.body);
  return results.length > 0 && results.every((result) => isConstantCollection(result, checker, depth + 1));
}

// Items drawn from a literal union (an enum or a list of known names) are a fixed, small domain.
function hasLiteralDomain(owner: RepeatOwner, checker: CheckerAdapter): boolean {
  const binding = elementBinding(owner);
  if (!binding || !ts.isIdentifier(binding)) return false;
  const type = checker.getTypeAtLocation(binding);
  const members = type.isUnion() && type.types ? type.types : [type];
  return members.every((member) => member.flags & literalFlags);
}

export { hasLiteralDomain, isConstantCollection, isConstantObject, iteratedCollection, passesCollection };
