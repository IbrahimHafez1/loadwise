import { ts } from './compiler.js';
import { awaitedResult, outsideWrappers } from './query-results.js';
import { prismaModelName, isGeneratedPrismaFile } from './prisma.js';
import { objectField, isPrismaTransactionMethod } from './prisma-integrity.js';
import type {
  CallExpression,
  Expression,
  Identifier,
  MemberName,
  Node,
  PropertySignature,
  Statement,
  TypeLiteralNode,
  TypeNode,
  VariableDeclaration,
  VariableStatement,
} from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext, SymbolAdapter } from '../shared/types.js';
import type { MethodCall } from './types/method-call.js';

/**
 * A value of a created row that points at an earlier creation, and the relation field when it is a
 * `connect`.
 */
interface RowDependency {
  reference: Identifier;
  relation: string | undefined;
}

const isMethodCall = (call: CallExpression): call is MethodCall => ts.isPropertyAccessExpression(call.expression);

function variableStatement(binding: VariableDeclaration): VariableStatement | undefined {
  const list = binding.parent;
  if (ts.isVariableDeclarationList(list) && list.declarations.length === 1 && ts.isVariableStatement(list.parent))
    return list.parent;
}

function directlyAwaitedStatement(call: CallExpression): Statement | undefined {
  const awaited = awaitedResult(call);
  if (!awaited) return;
  const expression = outsideWrappers(awaited);
  const parent = expression.parent;
  if (ts.isExpressionStatement(parent) || ts.isReturnStatement(parent)) return parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === expression) return variableStatement(parent);
}

function isStatementBlock(node: Node): boolean {
  return ts.isBlock(node) || ts.isSourceFile(node);
}

function singleConnectKey(value: Expression): Expression | undefined {
  if (!ts.isObjectLiteralExpression(value) || value.properties.length !== 1) return;
  const connect = objectField(value, 'connect');
  const selector = connect && ts.isPropertyAssignment(connect) ? connect.initializer : undefined;
  if (!selector) return;
  const object = ts.skipOuterExpressions(selector);
  if (!ts.isObjectLiteralExpression(object) || object.properties.length !== 1) return;
  const key = object.properties[0];
  if (ts.isPropertyAssignment(key) && (ts.isIdentifier(key.name) || ts.isStringLiteral(key.name)))
    return key.initializer;
}

function dependencies(row: Expression | undefined): RowDependency[] {
  if (!row || !ts.isObjectLiteralExpression(row)) return [];
  const seen = new Set<string>();
  const references: RowDependency[] = [];
  for (const property of row.properties) {
    if (
      (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) ||
      (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) ||
      seen.has(property.name.text)
    )
      return [];
    seen.add(property.name.text);
    if (!ts.isPropertyAssignment(property)) continue;
    const value = ts.skipOuterExpressions(property.initializer);
    const connectKey = singleConnectKey(value);
    const field = connectKey ? ts.skipOuterExpressions(connectKey) : value;
    if (!ts.isPropertyAccessExpression(field) || ts.isOptionalChain(field)) continue;
    if (!connectKey && (!/(?:Id|_id)$/.test(property.name.text) || field.name.text !== 'id')) continue;
    const result = ts.skipOuterExpressions(field.expression);
    if (ts.isIdentifier(result)) references.push({ reference: result, relation: connectKey && property.name.text });
  }
  return references;
}

// Generic create<T> contextualizes some input literals as their own inferred type. Look up the
// generated model input instead. One index serves all delegates in a namespace or file.
const generatedCreateInputs = new WeakMap<Node, Map<string, TypeLiteralNode>>();
function modelInputs(container: Node): Map<string, TypeLiteralNode> {
  const known = generatedCreateInputs.get(container);
  if (known) return known;
  const inputs = new Map<string, TypeLiteralNode>();
  const statements = ts.isSourceFile(container) || ts.isModuleBlock(container) ? container.statements : [];
  for (const statement of statements) {
    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text.endsWith('CreateInput') &&
      ts.isTypeLiteralNode(statement.type)
    ) {
      inputs.set(statement.name.text, statement.type);
    }
  }
  generatedCreateInputs.set(container, inputs);
  return inputs;
}

function acceptsUniqueSelector(type: TypeNode | undefined): boolean {
  if (!type) return false;
  if (ts.isUnionTypeNode(type)) return type.types.every(acceptsUniqueSelector);
  if (ts.isArrayTypeNode(type)) return acceptsUniqueSelector(type.elementType);
  if (!ts.isTypeReferenceNode(type)) return false;
  const name = ts.isQualifiedName(type.typeName) ? type.typeName.right : type.typeName;
  return name.text.endsWith('WhereUniqueInput');
}

function hasPropertyName(property: PropertySignature, name: string): boolean {
  const propertyName = property.name;
  return (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) && propertyName.text === name;
}

function isConnectSelector(member: Node): boolean {
  return ts.isPropertySignature(member) && hasPropertyName(member, 'connect') && acceptsUniqueSelector(member.type);
}

function isGeneratedRelation(method: MemberName, model: string, field: string, checker: CheckerAdapter): boolean {
  const delegate = checker.getSymbolAtLocation(method)?.declarations?.[0]?.parent;
  if (!delegate) return false;
  const inputs = modelInputs(delegate.parent);
  for (const inputName of [model + 'CreateInput', model + 'UncheckedCreateInput']) {
    const member = inputs
      .get(inputName)
      ?.members.find(
        (property): property is PropertySignature =>
          ts.isPropertySignature(property) && hasPropertyName(property, field),
      );
    if (!member?.type) continue;
    const declarations = checker.getTypeAtLocation(member.type).getSymbol()?.declarations;
    if (
      declarations?.some(
        (declaration) =>
          isGeneratedPrismaFile(declaration.getSourceFile()) &&
          (ts.isInterfaceDeclaration(declaration) ||
            ts.isTypeLiteralNode(declaration) ||
            ts.isClassLike(declaration)) &&
          declaration.members.some(isConnectSelector),
      )
    )
      return true;
  }
  return false;
}

// Follow immutable identifier aliases. A property getter or an arbitrary factory
// can return a different client each time it runs.
function resolveAlias(expression: Expression, checker: CheckerAdapter): Expression {
  let current = ts.skipOuterExpressions(expression);
  const visited = new Set<SymbolAdapter>();
  while (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    const binding = symbol?.valueDeclaration;
    if (
      !symbol ||
      !binding ||
      !ts.isVariableDeclaration(binding) ||
      !binding.initializer ||
      !(binding.parent.flags & ts.NodeFlags.Const) ||
      visited.has(symbol)
    )
      break;
    const initializer = ts.skipOuterExpressions(binding.initializer);
    if (!ts.isIdentifier(initializer) && !ts.isPropertyAccessExpression(initializer)) break;
    visited.add(symbol);
    current = initializer;
  }
  return current;
}

function fullClient(call: MethodCall, checker: CheckerAdapter): SymbolAdapter | undefined {
  const model = resolveAlias(call.expression.expression, checker);
  if (!ts.isPropertyAccessExpression(model)) return;
  const root = resolveAlias(model.expression, checker);
  if (!ts.isIdentifier(root)) return;
  const symbol = checker.getSymbolAtLocation(root);
  const binding = symbol?.valueDeclaration;
  if (binding && ts.isVariableDeclaration(binding) && !(binding.parent.flags & ts.NodeFlags.Const)) return;
  const type = checker.getTypeAtLocation(root).getSymbol();
  if (
    type?.name === 'PrismaClient' &&
    type.declarations?.some((declaration) => isGeneratedPrismaFile(declaration.getSourceFile()))
  )
    return symbol;
}

function previousCreation(
  reference: Identifier,
  nextStatement: Statement,
  checker: CheckerAdapter,
): MethodCall | undefined {
  const binding = checker.getSymbolAtLocation(reference)?.valueDeclaration;
  if (
    !binding ||
    !ts.isVariableDeclaration(binding) ||
    !ts.isIdentifier(binding.name) ||
    !binding.initializer ||
    !(binding.parent.flags & ts.NodeFlags.Const)
  )
    return;
  const statement = variableStatement(binding);
  // A statement's full span begins at the end of its preceding sibling, including
  // intervening trivia. This avoids walking all previous statements for every write.
  if (!statement || statement.parent !== nextStatement.parent || statement.end !== nextStatement.pos) return;
  const value = ts.skipOuterExpressions(binding.initializer);
  if (!ts.isAwaitExpression(value)) return;
  const create = ts.skipOuterExpressions(value.expression);
  if (
    ts.isCallExpression(create) &&
    isMethodCall(create) &&
    create.expression.name.text === 'create' &&
    !ts.isOptionalChain(create)
  )
    return create;
}

function inTransaction(statement: Statement, checker: CheckerAdapter): Node | undefined {
  return ts.findAncestor(
    statement,
    (ancestor) =>
      ts.isCallExpression(ancestor) &&
      ts.isPropertyAccessExpression(ancestor.expression) &&
      isPrismaTransactionMethod(ancestor.expression.name, checker),
  );
}

function checkDependentWrites(call: CallExpression, context: PerformanceRuleContext): void {
  if (
    !isMethodCall(call) ||
    (call.expression.name.text !== 'create' && call.expression.name.text !== 'createMany') ||
    ts.isOptionalChain(call) ||
    call.arguments.length !== 1
  )
    return;
  const method = call.expression;
  const statement = directlyAwaitedStatement(call);
  if (!statement || !isStatementBlock(statement.parent)) return;
  const dataField = objectField(ts.skipOuterExpressions(call.arguments[0]), 'data');
  const input = dataField && ts.isPropertyAssignment(dataField) ? dataField.initializer : undefined;
  if (!input) return;
  const data = ts.skipOuterExpressions(input);
  const rows = ts.isArrayLiteralExpression(data) ? data.elements : [data];
  const { checker } = context;
  for (const row of rows) {
    for (const { reference, relation } of dependencies(ts.skipOuterExpressions(row))) {
      const parent = previousCreation(reference, statement, checker);
      if (!parent) continue;
      const parentModel = prismaModelName(parent.expression.name, checker);
      const childModel = prismaModelName(method.name, checker);
      if (!parentModel || !childModel || parentModel === childModel) continue;
      const client = fullClient(parent, checker);
      if (!client || client !== fullClient(call, checker) || inTransaction(statement, checker)) continue;
      if (
        relation !== undefined &&
        (method.name.text !== 'create' || !isGeneratedRelation(method.name, childModel, relation, checker))
      )
        continue;
      context.report(
        method.name,
        'prisma-dependent-writes',
        `The ${childModel} write uses a value from the preceding ${parentModel} creation. If both must succeed or roll back together, wrap both in \`prisma.$transaction(async tx => { ... })\` using \`tx\`, or use a nested \`create\` on the parent.`,
      );
      return;
    }
  }
}

export { checkDependentWrites };
