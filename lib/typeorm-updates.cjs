'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { enclosingIteration, isPlainReference } = require('./site-fixes/helpers.cjs');

const loadMethods = new Set(['findOne', 'findOneBy', 'findOneOrFail', 'findOneByOrFail']);
// Decorators that make save() do more than write the assigned columns.
const updateHookDecorators = new Set(['BeforeUpdate', 'AfterUpdate', 'VersionColumn']);
const scalarFlags =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined;
const compoundKinds = new Map([
  [ts.SyntaxKind.EqualsToken, 'set'],
  [ts.SyntaxKind.PlusEqualsToken, 'increment'],
  [ts.SyntaxKind.MinusEqualsToken, 'decrement'],
]);
const maxWhereLength = 40;

function mentions(root, name) {
  let count = 0;
  (function visit(node) {
    if (ts.isIdentifier(node) && node.text === name) count++;
    ts.forEachChild(node, visit);
  })(root);
  return count;
}

function singleStatement(statement) {
  if (ts.isBlock(statement) && statement.statements.length === 1) return statement.statements[0];
  return statement;
}

// `if (!x) throw ...` / `if (!x) return ...` with nothing else.
function nullGuardOf(statement, name) {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return;
  const condition = ts.skipOuterExpressions(statement.expression);
  if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return;
  const operand = ts.skipOuterExpressions(condition.operand);
  if (!ts.isIdentifier(operand) || operand.text !== name) return;
  const body = singleStatement(statement.thenStatement);
  if (ts.isThrowStatement(body)) return { statement, throws: true };
  if (ts.isReturnStatement(body)) return { statement, throws: false };
}

function propertyOf(target, name) {
  if (!ts.isPropertyAccessExpression(target) || target.questionDotToken || !ts.isIdentifier(target.name)) return;
  return ts.isIdentifier(target.expression) && target.expression.text === name ? target : undefined;
}

// `x.a = value`, `x.n += value`, `x.n -= value`, `x.n++`, `x.n--`.
function stepOf(statement, name) {
  if (!ts.isExpressionStatement(statement)) return;
  const expression = ts.skipOuterExpressions(statement.expression);
  if (ts.isBinaryExpression(expression)) {
    const kind = compoundKinds.get(expression.operatorToken.kind);
    const access = propertyOf(expression.left, name);
    if (!kind || !access || mentions(expression.right, name)) return;
    return { statement, kind, access, field: access.name.text, value: expression.right };
  }
  const isUpdate = ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression);
  if (!isUpdate) return;
  const access = propertyOf(expression.operand, name);
  const operators = { [ts.SyntaxKind.PlusPlusToken]: 'increment', [ts.SyntaxKind.MinusMinusToken]: 'decrement' };
  const kind = operators[expression.operator];
  if (!kind || !access) return;
  return { statement, kind, access, field: access.name.text, value: undefined };
}

function whereOf(call) {
  const [first] = call.arguments;
  if (call.arguments.length !== 1 || !first) return;
  if (call.expression.name.text.startsWith('findOneBy')) return first;
  if (!ts.isObjectLiteralExpression(first) || first.properties.length !== 1) return;
  const [property] = first.properties;
  if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return;
  if (!ts.isIdentifier(property.name) || property.name.text !== 'where') return;
  return ts.isPropertyAssignment(property) ? property.initializer : property.name;
}

// The load statement `const x = await repo.findOne({ where: W })` that matches the saving repository.
function loadOf(statement, name, repositoryText) {
  if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) return;
  const [declaration] = statement.declarationList.declarations;
  if (statement.declarationList.declarations.length !== 1 || declaration.type) return;
  if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) return;
  const awaited = ts.skipOuterExpressions(declaration.initializer);
  if (!ts.isAwaitExpression(awaited)) return;
  const call = ts.skipOuterExpressions(awaited.expression);
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return;
  if (!loadMethods.has(call.expression.name.text) || call.expression.expression.getText() !== repositoryText) return;
  const where = whereOf(call);
  if (where) return { statement, declaration, method: call.expression.name.text, where };
}

function containerOf(node) {
  let current = node.parent;
  while (current.parent && !ts.isFunctionLike(current)) current = current.parent;
  return current;
}

// The purely syntactic shape of `const x = await repo.findOne(..); x.a = ..; await repo.save(x);` around a save call.
function loadThenSaveShape(call) {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'save' || call.arguments.length !== 1) return;
  const [entity] = call.arguments;
  if (!ts.isIdentifier(entity) || !isPlainReference(callee.expression)) return;
  const awaited = call.parent;
  const saveStatement = awaited.parent;
  if (!ts.isAwaitExpression(awaited) || !ts.isExpressionStatement(saveStatement)) return;
  if (!ts.isBlock(saveStatement.parent)) return;
  const statements = saveStatement.parent.statements;
  const name = entity.text;
  const repositoryText = callee.expression.getText();
  const steps = [];
  const guards = [];
  for (let index = statements.indexOf(saveStatement) - 1; index >= 0; index--) {
    const statement = statements[index];
    const load = loadOf(statement, name, repositoryText);
    if (load) {
      const used = steps.length + guards.length + 2;
      if (mentions(containerOf(statement), name) !== used) return;
      return {
        ...load,
        repositoryText,
        name,
        saveStatement,
        saveIndex: statements.indexOf(saveStatement),
        loadIndex: index,
        statements,
        steps: steps.reverse(),
        guards: guards.reverse(),
      };
    }
    const step = stepOf(statement, name);
    const guard = !step && nullGuardOf(statement, name);
    if (mentions(statement, name) !== 1 || (!step && !guard)) return;
    if (step) steps.push(step);
    else guards.push({ ...guard, index });
  }
}

function decoratorNames(member) {
  return (member.modifiers ?? []).flatMap((modifier) => {
    if (!ts.isDecorator(modifier)) return [];
    const expression = ts.isCallExpression(modifier.expression) ? modifier.expression.expression : modifier.expression;
    const name = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    return ts.isIdentifier(name) ? [name.text] : [];
  });
}

// False when an update listener, version column or unresolvable ancestry means save() may do more than the assignments.
// The native checker adapter has no getNonNullableType, so `Entity | null` is narrowed by hand.
function withoutNullish(type) {
  if (!type.isUnion()) return type;
  const members = type.types.filter((member) => !(member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
  return members.length === 1 ? members[0] : type;
}

function plainEntityClass(entityType, checker) {
  let current = entityType.getSymbol()?.valueDeclaration;
  const visited = new Set();
  while (current && !visited.has(current)) {
    if (!ts.isClassDeclaration(current)) return false;
    visited.add(current);
    const hooks = current.members.some((member) =>
      decoratorNames(member).some((decorator) => updateHookDecorators.has(decorator)),
    );
    if (hooks) return false;
    const inherited = current.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
    if (!inherited) return true;
    current = checker.getTypeAtLocation(inherited.types[0]).getSymbol()?.valueDeclaration;
  }
  return false;
}

function isColumnProperty(access, checker) {
  const declaration = checker.getSymbolAtLocation(access.name)?.valueDeclaration;
  return Boolean(
    declaration && ts.isPropertyDeclaration(declaration) && decoratorNames(declaration).includes('Column'),
  );
}

function typeVariants(type) {
  return type.isUnion() ? type.types : [type];
}

function isScalarValue(type) {
  return typeVariants(type).every((variant) => variant.flags & scalarFlags || variant.getSymbol()?.name === 'Date');
}

function isNumeric(type) {
  return typeVariants(type).every((variant) => variant.flags & ts.TypeFlags.NumberLike);
}

function stepAllowed(step, checker) {
  if (!isColumnProperty(step.access, checker)) return false;
  if (step.kind === 'set') return isScalarValue(checker.getTypeAtLocation(step.value));
  return (
    isNumeric(checker.getTypeAtLocation(step.access)) &&
    (!step.value || isNumeric(checker.getTypeAtLocation(step.value)))
  );
}

function listOf(names) {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function replacementOf(shape, whereText) {
  const sets = [...new Set(shape.steps.filter((step) => step.kind === 'set').map((step) => step.field))];
  const counters = shape.steps.filter((step) => step.kind !== 'set');
  if (sets.length) return `\`${shape.repositoryText}.update(${whereText}, { ${sets.join(', ')} })\` is one UPDATE`;
  const [counter] = counters;
  return `\`${shape.repositoryText}.${counter.kind}(${whereText}, '${counter.field}', ...)\` is one atomic UPDATE`;
}

function check(node, context) {
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'save') return;
  const shape = loadThenSaveShape(node);
  if (!shape?.steps.length || enclosingIteration(node)) return;
  if (!context.isPackageType(node.expression.expression, ['typeorm'], ['Repository'])) return;
  const { checker } = context;
  if (!plainEntityClass(withoutNullish(checker.getTypeAtLocation(shape.declaration.name)), checker)) return;
  if (!shape.steps.every((step) => stepAllowed(step, checker))) return;
  const fields = [...new Set(shape.steps.map((step) => step.field))];
  const whereText = shape.where.getText();
  const printable = whereText.length <= maxWhereLength && !whereText.includes('\n');
  const raceNote = shape.steps.some((step) => step.kind !== 'set')
    ? ' The `+=` on a loaded value can also lose concurrent updates; `increment()` is atomic.'
    : '';
  context.report(
    node.expression.name,
    'typeorm-load-then-save',
    `\`save(${shape.name})\` after loading it only to change ${listOf(fields)} costs a SELECT, an UPDATE and a transaction; ${replacementOf(shape, printable ? whereText.replace(/\s+/g, ' ') : 'where')}. Entity listeners and subscribers for update will not run, and @UpdateDateColumn is still set by update().${raceNote}`,
  );
}

module.exports = { check, loadThenSaveShape, mentions };
