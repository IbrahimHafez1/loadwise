'use strict';

// Request-input tracing shared by the page-size and offset rules: walks a computed value back to the request fields it
// reads and decides whether a cap is visible.
const { syntax: ts } = require('./compiler.cjs');
const { propertyName, symbolDeclarations } = require('./schema/ts-helpers.cjs');
const { parameterName } = require('./request-handlers.cjs');

const MAX_ALIAS_DEPTH = 4;
const MAX_SCHEMA_DEPTH = 3;
// A comparison against a literal this small is a lower-bound check such as `page < 1`.
const LOWER_BOUND_LITERAL = 1;
const REQUEST_PARAMETER_DECORATORS = new Set(['Query', 'Body', 'Param']);
const REQUEST_INPUT_MEMBERS = new Set(['query', 'body', 'params']);
const TRPC_INPUT = 'input';
const REQUEST_PARAMETER = /^req(?:uest)?$/;
const VALIDATOR_METHODS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync', 'validate', 'validateSync']);
const VALUE_PRESERVING_FUNCTIONS = new Set(['Number', 'parseInt', 'parseFloat']);
const VALUE_PRESERVING_MATH = new Set(['max', 'floor', 'ceil', 'round', 'trunc', 'abs']);
const CLAMP_NAME = /clamp|Math\.min/i;
// Validation text that caps a numeric field: zod, joi, yup and class-validator.
const MAX_CONSTRAINT = /\.(?:max|lte|lt|maximum|less)\(|@Max\(|\.between\(|@Clamp/;
const ARITHMETIC_OPERATORS = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);
const UPPER_BOUND_OPERATORS = new Set([ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken]);
const LOWER_BOUND_OPERATORS = new Set([ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken]);

function chainRoot(node) {
  let current = ts.skipOuterExpressions(node);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = ts.skipOuterExpressions(current.expression);
  }
  return current;
}

function leafName(node) {
  const value = ts.skipOuterExpressions(node);
  if (ts.isPropertyAccessExpression(value)) return value.name.text;
  if (ts.isElementAccessExpression(value) && ts.isStringLiteralLike(value.argumentExpression)) {
    return value.argumentExpression.text;
  }
  if (ts.isIdentifier(value)) return value.text;
}

function bindingFieldName(element) {
  const name = element.propertyName ?? element.name;
  return ts.isIdentifier(name) ? name.text : undefined;
}

function declaredNames(name) {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : declaredNames(element.name)));
}

function parameterDeclaring(scope, identifier) {
  return scope.parameters.find((parameter) =>
    declaredNames(parameter.name).some((name) => name.text === identifier.text),
  );
}

function localDeclarations(scope, name) {
  const found = [];
  (function visit(node) {
    if (ts.isVariableDeclaration(node) && declaredNames(node.name).some((declared) => declared.text === name)) {
      found.push(node);
    }
    if (node === scope.body || !ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  })(scope.body);
  return found;
}

function bindingElementFor(declaration, name) {
  if (ts.isIdentifier(declaration.name)) return;
  return (function find(pattern) {
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier(element.name) && element.name.text === name) return element;
      const nested = !ts.isIdentifier(element.name) && find(element.name);
      if (nested) return nested;
    }
  })(declaration.name);
}

// A variable that is reassigned through a clamp is bounded wherever it is read.
function isClampedByReassignment(scope, name) {
  let clamped = false;
  (function visit(node) {
    const isAssignment =
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left);
    if (isAssignment && node.left.text === name && CLAMP_NAME.test(node.right.getText())) clamped = true;
    ts.forEachChild(node, visit);
  })(scope.body);
  return clamped;
}

// Walks the value an offset is computed from back to the function inputs it reads. `sourceOf(parameter, node)` says
// whether reading `node` off that parameter counts as an input; Math.min and clamp calls cut the walk, since what
// they wrap is bounded.
function traceInputs(value, scope, sourceOf) {
  const sources = [];
  function visitReference(node, depth, fieldName, schema) {
    const root = chainRoot(node);
    if (!ts.isIdentifier(root)) return;
    const name = fieldName ?? leafName(node);
    const parameter = parameterDeclaring(scope, root);
    if (parameter) {
      const source = sourceOf(parameter, node);
      if (source) sources.push({ ...source, name, node, schema: schema ?? source.schema });
      return;
    }
    if (depth >= MAX_ALIAS_DEPTH || isClampedByReassignment(scope, root.text)) return;
    for (const declaration of localDeclarations(scope, root.text)) {
      if (!declaration.initializer) continue;
      const element = bindingElementFor(declaration, root.text);
      visit(declaration.initializer, depth + 1, element ? bindingFieldName(element) : name, schema);
    }
  }
  function visitCall(node, depth, fieldName, schema) {
    const callee = ts.skipOuterExpressions(node.expression);
    const text = callee.getText();
    if (CLAMP_NAME.test(text)) return;
    const isValidator = ts.isPropertyAccessExpression(callee) && VALIDATOR_METHODS.has(callee.name.text);
    const preservesValue =
      VALUE_PRESERVING_FUNCTIONS.has(text) ||
      (ts.isPropertyAccessExpression(callee) &&
        callee.expression.getText() === 'Math' &&
        VALUE_PRESERVING_MATH.has(callee.name.text));
    if (!isValidator && !preservesValue) return;
    const argumentSchema = isValidator ? callee.expression : schema;
    for (const argument of node.arguments) visit(argument, depth, fieldName, argumentSchema);
  }
  function visit(node, depth, fieldName, schema) {
    const current = ts.skipOuterExpressions(node);
    if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      visitReference(current, depth, fieldName, schema);
    } else if (ts.isAwaitExpression(current)) {
      visit(current.expression, depth, fieldName, schema);
    } else if (ts.isCallExpression(current)) {
      visitCall(current, depth, fieldName, schema);
    } else if (ts.isBinaryExpression(current) && ARITHMETIC_OPERATORS.has(current.operatorToken.kind)) {
      visit(current.left, depth, fieldName, schema);
      visit(current.right, depth, fieldName, schema);
    } else if (ts.isPrefixUnaryExpression(current)) {
      visit(current.operand, depth, fieldName, schema);
    } else if (ts.isConditionalExpression(current)) {
      visit(current.whenTrue, depth, fieldName, schema);
      visit(current.whenFalse, depth, fieldName, schema);
    }
  }
  visit(value, 0);
  return sources;
}

function isLowerBoundLiteral(node) {
  const value = ts.skipOuterExpressions(node);
  return ts.isNumericLiteral(value) && Number(value.text) <= LOWER_BOUND_LITERAL;
}

// `if (page > MAX_PAGE) ...` or `MAX_PAGE < page`: the field is compared against an upper limit somewhere.
function isComparedToUpperLimit(scope, name) {
  let compared = false;
  (function visit(node) {
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      const [subject, limit] = UPPER_BOUND_OPERATORS.has(operator) ? [node.left, node.right] : [node.right, node.left];
      const isComparison = UPPER_BOUND_OPERATORS.has(operator) || LOWER_BOUND_OPERATORS.has(operator);
      if (isComparison && leafName(subject) === name && !isLowerBoundLiteral(limit)) compared = true;
    }
    ts.forEachChild(node, visit);
  })(scope.body);
  return compared;
}

function declaresMaxFor(root, name) {
  let capped = false;
  let named = false;
  (function visit(node) {
    const isField =
      (ts.isPropertyAssignment(node) ||
        ts.isPropertyDeclaration(node) ||
        node.kind === ts.SyntaxKind.PropertySignature) &&
      propertyName(node) === name;
    if (isField) {
      named = true;
      if (MAX_CONSTRAINT.test(node.getText())) capped = true;
    }
    ts.forEachChild(node, visit);
  })(root);
  return { capped, named };
}

// A schema named by a reference is read from its declaration; an inline schema is read as written.
function schemaDeclarations(schema, context) {
  const value = ts.skipOuterExpressions(schema);
  if (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value)) return [value];
  return symbolDeclarations(value, context.checker);
}

// The declaration of a schema and of the schemas it is built from, such as `base.extend({ ... })`.
function schemaFields(schema, name, context, depth) {
  const fields = [];
  for (const declaration of schemaDeclarations(schema, context)) {
    fields.push(declaresMaxFor(declaration, name));
    const base =
      ts.isVariableDeclaration(declaration) && declaration.initializer && leftmostReference(declaration.initializer);
    if (base && depth < MAX_SCHEMA_DEPTH) fields.push(...schemaFields(base, name, context, depth + 1));
  }
  return fields;
}

function leftmostReference(expression) {
  let current = ts.skipOuterExpressions(expression);
  while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
    current = ts.skipOuterExpressions(current.expression);
  }
  return ts.isIdentifier(current) ? current : undefined;
}

// 'bounded' when a limit is visible, 'unknown' when the input is validated by a schema this scan cannot read,
// otherwise 'unbounded'.
function boundOf(source, scope, context) {
  if (isComparedToUpperLimit(scope, source.name)) return 'bounded';
  if (declaresMaxFor(source.node.getSourceFile(), source.name).capped) return 'bounded';
  if (ts.isPropertyAccessExpression(source.node)) {
    const declarations = context.checker.getSymbolAtLocation(source.node.name)?.declarations ?? [];
    if (declarations.some((declaration) => MAX_CONSTRAINT.test(declaration.getText()))) return 'bounded';
  }
  if (!source.schema) return 'unbounded';
  const fields = schemaFields(source.schema, source.name, context, 0);
  if (fields.some((field) => field.capped)) return 'bounded';
  return fields.some((field) => field.named) ? 'unbounded' : 'unknown';
}

function hasRequestDecorator(parameter) {
  return !!parameter.modifiers?.some(
    (modifier) =>
      ts.isDecorator(modifier) &&
      ts.isCallExpression(modifier.expression) &&
      ts.isIdentifier(modifier.expression.expression) &&
      REQUEST_PARAMETER_DECORATORS.has(modifier.expression.expression.text),
  );
}

// `procedure.input(schema).query(({ input }) => ...)`: the schema that validates the resolver's input.
function trpcInputSchema(handler) {
  for (let node = handler.parent?.expression; node; node = node.expression) {
    const isInputCall = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression);
    if (isInputCall && node.expression.name.text === 'input') return node.arguments[0];
    if (!ts.isCallExpression(node) && !ts.isPropertyAccessExpression(node)) return;
  }
}

function isTrpcInput(handler, parameter, node) {
  const pattern = parameter === handler.parameters[0] && parameter.name;
  if (!pattern || !ts.isObjectBindingPattern(pattern) || chainRoot(node).text !== TRPC_INPUT) return false;
  return pattern.elements.some((element) => ts.isIdentifier(element.name) && element.name.text === TRPC_INPUT);
}

function requestInputOf(handler) {
  return (parameter, node) => {
    if (hasRequestDecorator(parameter)) return {};
    if (isTrpcInput(handler, parameter, node)) return { schema: trpcInputSchema(handler) };
    const isRequestObject =
      parameter === handler.parameters[0] && REQUEST_PARAMETER.test(parameterName(parameter) ?? '');
    if (!isRequestObject) return;
    const member = ts.skipOuterExpressions(node);
    const firstSegment = ts.isPropertyAccessExpression(member) && memberAfterRoot(member);
    if (firstSegment && REQUEST_INPUT_MEMBERS.has(firstSegment)) return {};
  };
}

// `req.query.page` -> 'query'.
function memberAfterRoot(access) {
  let current = access;
  while (ts.isPropertyAccessExpression(current.expression)) current = current.expression;
  return current.name.text;
}

module.exports = { traceInputs, boundOf, requestInputOf, chainRoot, leafName, declaredNames };
