'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { awaitedResult, outsideWrappers } = require('./query-results.cjs');
const { prismaModelName, isGeneratedPrismaFile } = require('./prisma.cjs');
const { objectField, isPrismaTransactionMethod } = require('./prisma-integrity.cjs');

function variableStatement(binding) {
  const list = binding.parent;
  if (ts.isVariableDeclarationList(list) && list.declarations.length === 1 && ts.isVariableStatement(list.parent))
    return list.parent;
}

function directlyAwaitedStatement(call) {
  const awaited = awaitedResult(call);
  if (!awaited) return;
  const expression = outsideWrappers(awaited);
  const parent = expression.parent;
  if (ts.isExpressionStatement(parent) || ts.isReturnStatement(parent)) return parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === expression) return variableStatement(parent);
}

function isStatementBlock(node) {
  return ts.isBlock(node) || ts.isSourceFile(node);
}

function singleConnectKey(value) {
  if (!ts.isObjectLiteralExpression(value) || value.properties.length !== 1) return;
  const selector = objectField(value, 'connect')?.initializer;
  if (!selector) return;
  const object = ts.skipOuterExpressions(selector);
  if (!ts.isObjectLiteralExpression(object) || object.properties.length !== 1) return;
  const key = object.properties[0];
  if (ts.isPropertyAssignment(key) && (ts.isIdentifier(key.name) || ts.isStringLiteral(key.name)))
    return key.initializer;
}

function dependencies(row) {
  if (!row || !ts.isObjectLiteralExpression(row)) return [];
  const seen = new Set();
  const references = [];
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

// Generic create<T> contextualizes some input literals as their own inferred type.
// Look up the generated model input instead. One index serves all delegates in a namespace or file.
const generatedCreateInputs = new WeakMap();
function modelInputs(container) {
  if (!generatedCreateInputs.has(container)) {
    const inputs = new Map();
    for (const statement of container.statements ?? []) {
      if (
        ts.isTypeAliasDeclaration(statement) &&
        statement.name.text.endsWith('CreateInput') &&
        ts.isTypeLiteralNode(statement.type)
      ) {
        inputs.set(statement.name.text, statement.type);
      }
    }
    generatedCreateInputs.set(container, inputs);
  }
  return generatedCreateInputs.get(container);
}

function acceptsUniqueSelector(type) {
  if (!type) return false;
  if (ts.isUnionTypeNode(type)) return type.types.every(acceptsUniqueSelector);
  if (ts.isArrayTypeNode(type)) return acceptsUniqueSelector(type.elementType);
  if (!ts.isTypeReferenceNode(type)) return false;
  const name = ts.isQualifiedName(type.typeName) ? type.typeName.right : type.typeName;
  return name.text.endsWith('WhereUniqueInput');
}

function isGeneratedRelation(method, model, field, checker) {
  const delegate = checker.getSymbolAtLocation(method).declarations[0].parent;
  const inputs = modelInputs(delegate.parent);
  for (const inputName of [model + 'CreateInput', model + 'UncheckedCreateInput']) {
    const member = inputs.get(inputName)?.members.find((property) => property.name?.text === field);
    if (!member?.type) continue;
    const declarations = checker.getTypeAtLocation(member.type).getSymbol()?.declarations;
    if (
      declarations?.some(
        (type) =>
          isGeneratedPrismaFile(type.getSourceFile()) &&
          type.members?.some(
            (property) =>
              property.kind === ts.SyntaxKind.PropertySignature &&
              property.name?.text === 'connect' &&
              acceptsUniqueSelector(property.type),
          ),
      )
    )
      return true;
  }
  return false;
}

// Follow immutable identifier aliases. A property getter or an arbitrary factory
// can return a different client each time it runs.
function resolveAlias(expression, checker) {
  let current = ts.skipOuterExpressions(expression);
  const visited = new Set();
  while (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    const binding = symbol?.valueDeclaration;
    if (
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

function fullClient(call, checker) {
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

function previousCreation(reference, nextStatement, checker) {
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
    ts.isPropertyAccessExpression(create.expression) &&
    create.expression.name.text === 'create' &&
    !ts.isOptionalChain(create)
  )
    return create;
}

function inTransaction(statement, checker) {
  return ts.findAncestor(
    statement,
    (ancestor) =>
      ts.isCallExpression(ancestor) &&
      ts.isPropertyAccessExpression(ancestor.expression) &&
      isPrismaTransactionMethod(ancestor.expression.name, checker),
  );
}

function checkDependentWrites(call, context) {
  const method = call.expression;
  if (
    !ts.isPropertyAccessExpression(method) ||
    (method.name.text !== 'create' && method.name.text !== 'createMany') ||
    ts.isOptionalChain(call) ||
    call.arguments.length !== 1
  )
    return;
  const statement = directlyAwaitedStatement(call);
  if (!statement || !isStatementBlock(statement.parent)) return;
  const input = objectField(ts.skipOuterExpressions(call.arguments[0]), 'data')?.initializer;
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
        `The ${childModel} write uses a value from the preceding ${parentModel} creation. If both must succeed or roll back together, use a nested write or a transaction and run both operations on its client.`,
      );
      return;
    }
  }
}

module.exports = { checkDependentWrites };
