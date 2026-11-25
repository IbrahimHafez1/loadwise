import { loadSyntax, isDefaultLibrary } from './compiler.cjs';
import { standardInterface } from './repeated.cjs';
import type {
  CallExpression,
  Declaration,
  ElementAccessExpression,
  Expression,
  Identifier,
  Node,
  ParameterDeclaration,
  PropertyAccessExpression,
  TypeNode,
  VariableDeclaration,
} from 'typescript';
import type { CheckerAdapter, SymbolAdapter, TypeAdapter } from '../shared/types.cjs';
import type {
  CallbackFunction,
  ConstantDeclaration,
  IdentifierParameter,
  TypeWithProperties,
  UnchangedConstant,
  WrittenBindings,
} from './types/collections.cjs';
import type { MethodCall } from './types/method-call.cjs';
const ts = loadSyntax();

export const smallLiteralLimit = 8;
// A literal list of plain values is as cheap to scan as a Set is to build up to roughly this
// length.
export const constantListLimit = 16;
// A list of distinct enum or literal values cannot outgrow its declared members; larger unions are
// not hand-sized.
export const finiteDomainLimit = 64;
// Constant tables are authored by hand, so they stay short even past the inline limit.
export const constantTableLimit = 20;
export const maxBoundDepth = 8;
export const arrays = new Set(['Array', 'ReadonlyArray']);
export const setTypes = new Set(['Set', 'ReadonlySet']);
export const repeatableCollections = new Set([...arrays, ...setTypes, 'Map', 'ReadonlyMap']);
export const fallbackOperators = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken]);

const mutatingMethods = new Set([
  'add',
  'clear',
  'copyWithin',
  'delete',
  'fill',
  'pop',
  'push',
  'reverse',
  'set',
  'shift',
  'sort',
  'splice',
  'unshift',
]);
const callbacksReceivingArray = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
]);
const writesByChecker = new WeakMap<CheckerAdapter, WeakMap<Node, WrittenBindings>>();

export const isAccessExpression = (node: Node): node is PropertyAccessExpression | ElementAccessExpression =>
  ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);

export const isMethodCall = (node: Node): node is MethodCall =>
  ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression);

export const listsProperties = (type: TypeAdapter): type is TypeWithProperties =>
  'getProperties' in type && typeof type.getProperties === 'function';

export const hasInitializer = (declaration: VariableDeclaration): declaration is ConstantDeclaration =>
  declaration.initializer !== undefined;

export const hasIdentifierName = (parameter: ParameterDeclaration): parameter is IdentifierParameter =>
  ts.isIdentifier(parameter.name);

// The type annotation of a variable, parameter or property, which is where a tuple type is written.
export function declaredTypeNode(declaration: Node | undefined): TypeNode | undefined {
  if (
    declaration &&
    (ts.isVariableDeclaration(declaration) ||
      ts.isParameter(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertySignature(declaration))
  )
    return declaration.type;
}

// The value a variable, parameter or property starts with.
export function declaredInitializer(declaration: Node | undefined): Expression | undefined {
  if (
    declaration &&
    (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) || ts.isPropertyDeclaration(declaration))
  )
    return declaration.initializer;
}

export function sameIdentifier(expression: Node, target: Identifier): boolean {
  return ts.isIdentifier(expression) && expression.text === target.text;
}

export function typeParts(type: TypeAdapter): readonly TypeAdapter[] {
  return type.isUnion() ? (type.types ?? [type]) : [type];
}

export function syncCallback(expression: Expression | undefined): CallbackFunction | undefined {
  if (!expression) return;
  const callback = ts.skipOuterExpressions(expression);
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return;
  if (!(ts.getCombinedModifierFlags(callback) & ts.ModifierFlags.Async) && !callback.asteriskToken) return callback;
}

export function resolvedSymbol(identifier: Identifier, checker: CheckerAdapter): SymbolAdapter | undefined {
  const symbol = checker.getSymbolAtLocation(identifier);
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

export function isModuleLevel(declaration: Declaration): boolean {
  const grandparent = declaration.parent?.parent?.parent;
  return grandparent !== undefined && ts.isSourceFile(grandparent);
}

export function isConstAssertion(initializer: Expression): boolean {
  let expression = initializer;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return (
    ts.isAsExpression(expression) &&
    ts.isTypeReferenceNode(expression.type) &&
    ts.isIdentifier(expression.type.typeName) &&
    expression.type.typeName.text === 'const'
  );
}

export function isObjectAssign(call: CallExpression, checker: CheckerAdapter): boolean {
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'assign' &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Object' &&
    !ts.isOptionalChain(call) &&
    standardInterface(call, checker) === 'ObjectConstructor'
  );
}

export function nativeCollection(expression: Expression, names: ReadonlySet<string>, checker: CheckerAdapter): boolean {
  const symbol = checker.getTypeAtLocation(expression).getSymbol();
  return (
    symbol !== undefined &&
    names.has(symbol.name) &&
    (symbol.declarations?.some((declaration) => isDefaultLibrary(checker, declaration.getSourceFile())) ?? false)
  );
}

// Cache by iteration site so multiple lookups in one loop share a single write scan.
export function writtenBindings(owner: Node, checker: CheckerAdapter): WrittenBindings {
  // Watch builds can reuse a loop's syntax tree with a new checker's symbols.
  let writesByOwner = writesByChecker.get(checker);
  if (!writesByOwner) {
    writesByOwner = new WeakMap();
    writesByChecker.set(checker, writesByOwner);
  }
  const known = writesByOwner.get(owner);
  if (known) return known;
  const bindings: WrittenBindings = {
    mutated: new Set(),
    passed: new Map(),
    reassigned: new Map(),
    aliases: new Set(),
  };
  function alias(expression: Expression | undefined): void {
    if (!expression) return;
    const value = ts.skipOuterExpressions(expression);
    if (ts.isIdentifier(value)) {
      // A same-named binding in a nested scope can only make this proof more conservative.
      bindings.aliases.add(value.text);
    } else if (ts.isConditionalExpression(value)) {
      alias(value.whenTrue);
      alias(value.whenFalse);
    }
  }
  function record(expression: Expression): void {
    const target = ts.skipOuterExpressions(expression);
    if (ts.isIdentifier(target)) bindings.mutated.add(checker.getSymbolAtLocation(target));
  }
  function recordPassed(expression: Expression, position: number): void {
    const target = ts.skipOuterExpressions(expression);
    if (!ts.isIdentifier(target)) return;
    const symbol = checker.getSymbolAtLocation(target);
    bindings.passed.set(symbol, Math.min(position, bindings.passed.get(symbol) ?? Infinity));
  }
  function recordAssignment(target: Expression): void {
    if (ts.isIdentifier(target)) {
      const symbol = checker.getSymbolAtLocation(target);
      bindings.reassigned.set(symbol, bindings.reassigned.has(symbol) ? undefined : target);
      return;
    }
    let accessed = target;
    while (isAccessExpression(accessed)) accessed = ts.skipOuterExpressions(accessed.expression);
    record(accessed);
  }
  // loadwise-reviewed high-branch-complexity -- flat dispatch over independent, mutually exclusive syntax kinds that feed one shared bindings record; each arm is one line
  function visit(node: Node): void {
    if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
      recordAssignment(ts.skipOuterExpressions(node.left));
      alias(node.right);
    } else if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) {
      alias(node.initializer);
    } else if (ts.isShorthandPropertyAssignment(node)) {
      alias(node.name);
    } else if (ts.isExportSpecifier(node)) {
      alias(node.propertyName || node.name);
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) alias(element);
    } else if (ts.isReturnStatement(node)) {
      alias(node.expression);
    } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      alias(node.body);
    } else if (ts.isNewExpression(node)) {
      for (const argument of node.arguments || []) alias(argument);
    } else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      recordAssignment(ts.skipOuterExpressions(node.initializer));
    } else if (ts.isDeleteExpression(node)) {
      recordAssignment(ts.skipOuterExpressions(node.expression));
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      recordAssignment(ts.skipOuterExpressions(node.operand));
    } else if (ts.isCallExpression(node)) {
      const access = node.expression;
      if (ts.isPropertyAccessExpression(access) && mutatingMethods.has(access.name.text)) {
        record(access.expression);
      } else if (
        ts.isPropertyAccessExpression(access) &&
        callbacksReceivingArray.has(access.name.text) &&
        node.arguments.length > 0
      ) {
        // Built-in iteration callbacks can expose the source as their last argument.
        const callback = ts.skipOuterExpressions(node.arguments[0]);
        if (
          !ts.isFunctionLike(callback) ||
          callback.parameters.length >= 3 ||
          callback.parameters.some((parameter) => parameter.dotDotDotToken)
        ) {
          alias(access.expression);
        }
      } else if (ts.isElementAccessExpression(access)) {
        const key = ts.skipOuterExpressions(access.argumentExpression);
        if (!ts.isStringLiteralLike(key) || mutatingMethods.has(key.text)) record(access.expression);
      }
      // A callee taking the array can change membership through its argument, from the call onward.
      // The built-in Object.assign only reads its sources, so just its target counts.
      const passedArguments = isObjectAssign(node, checker) ? node.arguments.slice(0, 1) : node.arguments;
      for (const argument of passedArguments) recordPassed(argument, node.pos);
    }
    ts.forEachChild(node, visit);
  }
  visit(owner);
  writesByOwner.set(owner, bindings);
  return bindings;
}

export function externalBinding(
  identifier: Identifier,
  owner: Node,
  checker: CheckerAdapter,
): SymbolAdapter | undefined {
  const symbol = checker.getSymbolAtLocation(identifier);
  const binding = symbol?.valueDeclaration;
  if (!binding || (!ts.isParameter(binding) && !ts.isVariableDeclaration(binding))) return;
  if (binding.getSourceFile() === owner.getSourceFile() && binding.pos >= owner.pos && binding.end <= owner.end) return;
  return symbol;
}

export function mayChange(symbol: SymbolAdapter | undefined, owner: Node, checker: CheckerAdapter): boolean {
  const writes = writtenBindings(owner, checker);
  return writes.mutated.has(symbol) || writes.passed.has(symbol) || writes.reassigned.has(symbol);
}

// A call after the use cannot change what the use already read, so only earlier calls count there.
export function mayChangeBefore(
  symbol: SymbolAdapter | undefined,
  scope: Node,
  usePosition: number,
  checker: CheckerAdapter,
): boolean {
  const writes = writtenBindings(scope, checker);
  return (
    writes.mutated.has(symbol) || writes.reassigned.has(symbol) || (writes.passed.get(symbol) ?? Infinity) < usePosition
  );
}

// A const declaration whose value nobody in this file or its declaring file changes before the use.
export function unchangedConstant(identifier: Identifier, checker: CheckerAdapter): UnchangedConstant | undefined {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declarationSymbol = resolvedSymbol(identifier, checker);
  const binding = declarationSymbol?.valueDeclaration;
  if (
    !binding ||
    !ts.isVariableDeclaration(binding) ||
    !hasInitializer(binding) ||
    !(binding.parent.flags & ts.NodeFlags.Const)
  )
    return;
  const imported = symbol !== declarationSymbol;
  const exported = ts.getCombinedModifierFlags(binding) & ts.ModifierFlags.Export;
  if (exported && !imported && !isConstAssertion(binding.initializer)) return;
  const scope = ts.findAncestor(binding, (node) => ts.isFunctionLike(node) || ts.isSourceFile(node));
  if (!scope) return;
  const usePosition = scope.getSourceFile() === identifier.getSourceFile() ? identifier.pos : Infinity;
  if (mayChangeBefore(declarationSymbol, scope, usePosition, checker)) return;
  if (imported && mayChangeBefore(symbol, identifier.getSourceFile(), identifier.pos, checker)) return;
  return { binding, scope, imported };
}
