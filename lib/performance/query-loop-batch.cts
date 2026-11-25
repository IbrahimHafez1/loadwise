import { isDefaultLibrary, loadSyntax } from './compiler.cjs';
import { fixedBatchSize, localInitializer, readProperty, sameBinding } from './query-loop-helpers.cjs';
import { hasShortPageExit, isPageScan } from './query-loop-pagination.cjs';
import { isStandardArrayCall } from './repeated.cjs';
import type { CallExpression, Expression, Node } from 'typescript';
import type { CheckerAdapter } from '../shared/types.cjs';
import type { RepeatOwner } from './types/repeat-owner.cjs';
const ts = loadSyntax();

function projectsSingletons(expression: Expression, checker: CheckerAdapter, depth = 0): boolean {
  if (depth > 6) return false;
  const value = ts.skipOuterExpressions(expression);
  const singleton = (item: Node): boolean =>
    ts.isArrayLiteralExpression(item) && item.elements.length <= 1 && !item.elements.some(ts.isSpreadElement);
  if (ts.isArrayLiteralExpression(value)) return value.elements.every(singleton);
  if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) {
    const callback = value.arguments[0];
    if (value.expression.name.text === 'map' && callback && ts.isArrowFunction(callback)) {
      const result = ts.skipOuterExpressions(callback.body);
      return (
        singleton(result) ||
        (ts.isBlock(result) &&
          result.statements.length === 1 &&
          ts.isReturnStatement(result.statements[0]) &&
          !!result.statements[0].expression &&
          singleton(result.statements[0].expression))
      );
    }
    return (
      ['filter', 'slice'].includes(value.expression.name.text) &&
      projectsSingletons(value.expression.expression, checker, depth + 1)
    );
  }
  if (!ts.isIdentifier(value)) return false;
  const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;
  return (
    !!declaration &&
    ts.isVariableDeclaration(declaration) &&
    !!(declaration.parent.flags & ts.NodeFlags.Const) &&
    !!declaration.initializer &&
    projectsSingletons(declaration.initializer, checker, depth + 1)
  );
}

function projectsItem(callback: Expression | undefined, checker: CheckerAdapter): boolean {
  if (!callback || !ts.isArrowFunction(callback) || !callback.parameters.length) return false;
  const parameter = callback.parameters[0];
  const body = ts.skipOuterExpressions(callback.body);
  if (ts.isBlock(body)) return false;
  function usesParameter(node: Node): boolean | undefined {
    if (ts.isIdentifier(node)) {
      const symbol =
        ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
      const binding = symbol?.valueDeclaration;
      return (
        !!binding &&
        binding.getSourceFile() === parameter.getSourceFile() &&
        binding.pos >= parameter.pos &&
        binding.end <= parameter.end
      );
    }
    return ts.forEachChild(node, (child) => usesParameter(child) || undefined);
  }
  return !!usesParameter(body);
}

function isBatchCollection(
  expression: Expression | undefined,
  owner: RepeatOwner,
  checker: CheckerAdapter,
  depth = 0,
): boolean {
  if (!expression || depth > 8) return false;
  const value = ts.skipOuterExpressions(expression);
  const follows = (child: Expression | undefined): boolean => isBatchCollection(child, owner, checker, depth + 1);
  if (ts.isIdentifier(value)) {
    if (
      ts.isForOfStatement(owner) &&
      ts.isVariableDeclarationList(owner.initializer) &&
      sameBinding(value, owner.initializer.declarations[0].name, checker)
    ) {
      const type = checker.getTypeAtLocation(value).getSymbol();
      return (
        !!type &&
        (type.name === 'Array' || type.name === 'ReadonlyArray') &&
        !!type.declarations?.some((declaration) => isDefaultLibrary(checker, declaration.getSourceFile())) &&
        !projectsSingletons(owner.expression, checker)
      );
    }
    const initializer = localInitializer(value, owner, checker);
    if (!initializer) return false;
    if (isPageScan(owner) && ts.isAwaitExpression(initializer) && hasShortPageExit(value, owner, checker)) return true;
    return follows(initializer);
  }
  if (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    ['map', 'flatMap', 'filter'].includes(value.expression.name.text) &&
    isStandardArrayCall(value, checker)
  ) {
    return (
      (value.expression.name.text === 'filter' || projectsItem(value.arguments[0], checker)) &&
      follows(value.expression.expression)
    );
  }
  if (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === 'slice' &&
    ts.isForStatement(owner) &&
    owner.incrementor &&
    ts.isBinaryExpression(owner.incrementor) &&
    owner.incrementor.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
    value.arguments.length === 2
  ) {
    const [start, end] = value.arguments;
    const stride = fixedBatchSize(owner.incrementor.right, checker);
    return (
      stride !== undefined &&
      sameBinding(start, owner.incrementor.left, checker) &&
      ts.isBinaryExpression(end) &&
      end.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      sameBinding(start, end.left, checker) &&
      fixedBatchSize(end.right, checker) === stride &&
      isStandardArrayCall(value, checker)
    );
  }
  if (ts.isArrayLiteralExpression(value) && value.elements.length === 1 && ts.isSpreadElement(value.elements[0])) {
    return follows(value.elements[0].expression);
  }
  if (
    ts.isNewExpression(value) &&
    value.arguments?.length === 1 &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === 'Set'
  ) {
    const origin = checker.getSymbolAtLocation(value.expression)?.valueDeclaration;
    return !!origin && isDefaultLibrary(checker, origin.getSourceFile()) && follows(value.arguments[0]);
  }
  return false;
}

function prismaMapArm(value: CallExpression, owner: RepeatOwner, checker: CheckerAdapter): boolean {
  const callback = value.arguments[0];
  if (
    !callback ||
    !ts.isArrowFunction(callback) ||
    !callback.parameters.length ||
    !ts.isIdentifier(callback.parameters[0].name)
  )
    return false;
  const filter = ts.skipOuterExpressions(callback.body);
  // `OR: page.map((row) => filterFor(row.id, row.since))` builds one arm per row through a
  // helper.
  if (ts.isCallExpression(filter) && projectsItem(callback, checker)) return true;
  return (
    ts.isObjectLiteralExpression(filter) &&
    filter.properties.some(
      (field) =>
        ts.isPropertyAssignment(field) &&
        !ts.isComputedPropertyName(field.name) &&
        readProperty(filter, field.name.text) === field.initializer &&
        ts.isPropertyAccessExpression(field.initializer) &&
        sameBinding(field.initializer.expression, callback.parameters[0].name, checker),
    )
  );
}

function isPrismaBatchProperty(name: string, value: Expression, owner: RepeatOwner, checker: CheckerAdapter): boolean {
  if (name !== 'NOT' && name !== 'AND' && name !== 'OR' && isBatchCollection(readProperty(value, 'in'), owner, checker))
    return true;
  if (name !== 'OR') return false;
  if (ts.isArrayLiteralExpression(value) && batchPredicate(value, owner, checker, 'Prisma')) return true;
  return (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === 'map' &&
    isBatchCollection(value, owner, checker) &&
    prismaMapArm(value, owner, checker)
  );
}

function isTypeormInProperty(value: Expression, owner: RepeatOwner, checker: CheckerAdapter): boolean {
  if (
    !ts.isCallExpression(value) ||
    value.arguments.length !== 1 ||
    !isBatchCollection(value.arguments[0], owner, checker)
  )
    return false;
  const declaration = checker.getResolvedSignature(value)?.declaration;
  const declaredName = declaration && ts.isFunctionLike(declaration) ? declaration.name : undefined;
  return (
    !!declaration &&
    !!declaredName &&
    !ts.isComputedPropertyName(declaredName) &&
    declaredName.text === 'In' &&
    /\/node_modules\/typeorm\//.test(declaration.getSourceFile().fileName.replaceAll('\\', '/'))
  );
}

function batchPredicate(
  predicate: Expression | undefined,
  owner: RepeatOwner,
  checker: CheckerAdapter,
  family: string | undefined,
): boolean {
  if (!predicate) return false;
  // TypeORM WHERE arrays are disjunctions. One unrestricted arm broadens the entire match.
  if (ts.isArrayLiteralExpression(predicate))
    return (
      predicate.elements.length > 0 && predicate.elements.every((item) => batchPredicate(item, owner, checker, family))
    );
  if (!ts.isObjectLiteralExpression(predicate)) return false;
  const seen = new Set<string>();
  for (let index = predicate.properties.length - 1; index >= 0; index--) {
    const property = predicate.properties[index];
    if (!property.name || ts.isComputedPropertyName(property.name)) return false;
    const name = property.name.text;
    if (seen.has(name)) continue;
    seen.add(name);
    if (!ts.isPropertyAssignment(property)) continue;
    const value = property.initializer;
    if (family === 'Prisma' && isPrismaBatchProperty(name, value, owner, checker)) return true;
    if (family === 'TypeORM' && isTypeormInProperty(value, owner, checker)) return true;
  }
  return false;
}

export { batchPredicate, isBatchCollection };
