// Site fixes for reduce-copy-accumulator and loop-copy-accumulator: an accumulator copied on every
// step is updated in place.
import { ts, textOf, ancestor, indentationAt } from './helpers.js';
import type {
  ArrayLiteralExpression,
  ArrowFunction,
  BinaryExpression,
  Block,
  CallExpression,
  FunctionExpression,
  Identifier,
  Node,
  ObjectLiteralElementLike,
  ObjectLiteralExpression,
  SpreadAssignment,
  SpreadElement,
  VariableDeclaration,
} from 'typescript';
import type { FixResult, SiteFixInput } from '../../shared/types.js';
import {
  typeScriptFile,
  readOnlyArrayMembers,
  arrayCopyIndent,
  skipParentheses,
  outerParenthesized,
  nearestFunctionOrFile,
  bindingNames,
  bindsName,
  isAssignmentTarget,
} from './collection-helpers.js';

interface AccumulatorDeclaration {
  declaration: VariableDeclaration;
  scope: Node;
}

function copiedAccumulatorStatements(
  literal: ArrayLiteralExpression | ObjectLiteralExpression,
  accumulator: string,
): string[] | undefined {
  if (ts.isArrayLiteralExpression(literal)) {
    const [, ...added] = literal.elements;
    if (added.length === 0 || added.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element)))
      return;
    return [`${accumulator}.push(${added.map(textOf).join(', ')});`];
  }
  const [, ...added] = literal.properties;
  if (added.length === 0) return;
  const statements: string[] = [];
  for (const property of added) {
    const target = propertyTarget(property, accumulator);
    if (!target) return;
    statements.push(target);
  }
  return statements;
}

function propertyTarget(property: ObjectLiteralElementLike, accumulator: string): string | undefined {
  if (ts.isShorthandPropertyAssignment(property)) {
    if (property.name.text === '__proto__' || property.objectAssignmentInitializer) return;
    return `${accumulator}.${property.name.text} = ${property.name.text};`;
  }
  if (!ts.isPropertyAssignment(property)) return;
  const { name } = property;
  const value = textOf(property.initializer);
  if (ts.isComputedPropertyName(name)) return `${accumulator}[${textOf(name.expression)}] = ${value};`;
  if (ts.isIdentifier(name) && name.text !== '__proto__') return `${accumulator}.${name.text} = ${value};`;
  if (ts.isStringLiteralLike(name) && name.text !== '__proto__') return `${accumulator}[${textOf(name)}] = ${value};`;
}

type CopyLiteral = ArrayLiteralExpression | ObjectLiteralExpression;

interface CopySpreadSite {
  readonly literal: CopyLiteral;
  readonly copiedSource: Identifier;
}

interface ReduceCallback {
  readonly callback: ArrowFunction | FunctionExpression;
  readonly reduce: CallExpression;
}

interface AccumulatorParameter {
  readonly name: string;
  readonly hasType: boolean;
}

// The leading `...accumulator` spread of the array or object literal that contains the node.
function findCopySpread(node: Node): CopySpreadSite | undefined {
  const spread = ancestor(
    node,
    (current): current is SpreadElement | SpreadAssignment =>
      ts.isSpreadElement(current) || ts.isSpreadAssignment(current),
  );
  const literal = spread?.parent;
  if (!spread || !literal || (!ts.isArrayLiteralExpression(literal) && !ts.isObjectLiteralExpression(literal))) return;
  const entries = ts.isArrayLiteralExpression(literal) ? literal.elements : literal.properties;
  if (entries[0] !== spread) return;
  const copiedSource = skipParentheses(spread.expression);
  if (!ts.isIdentifier(copiedSource)) return;
  return { literal, copiedSource };
}

function isReduceWithInitial(reduce: Node, callback: Node): reduce is CallExpression {
  return (
    ts.isCallExpression(reduce) &&
    reduce.arguments[0] === callback &&
    reduce.arguments.length === 2 &&
    ts.isPropertyAccessExpression(reduce.expression) &&
    reduce.expression.name.text === 'reduce' &&
    !ts.isOptionalChain(reduce)
  );
}

function findReduceCallback(literal: CopyLiteral): ReduceCallback | undefined {
  const callback = ancestor(literal, ts.isFunctionLike);
  if (!callback) return;
  const reduce = callback.parent;
  if (!isReduceWithInitial(reduce, callback)) return;
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return;
  return { callback, reduce };
}

function plainAccumulator(callback: ArrowFunction | FunctionExpression): AccumulatorParameter | undefined {
  const [accumulator] = callback.parameters;
  if (!accumulator || !ts.isIdentifier(accumulator.name) || accumulator.initializer || accumulator.dotDotDotToken)
    return;
  return { name: accumulator.name.text, hasType: Boolean(accumulator.type) };
}

// Without a type on the accumulator, reduce() or an assertion on the initial value, TypeScript
// types the accumulator as the literal's own shape: the spread copy accepts a new key but an
// assignment of it does not.
function typesAccumulator(reduce: CallExpression, accumulator: AccumulatorParameter): boolean {
  return (
    accumulator.hasType ||
    Boolean(reduce.typeArguments) ||
    !ts.isObjectLiteralExpression(skipParentheses(reduce.arguments[1]))
  );
}

function initialValueAllowsRewrite(
  reduce: CallExpression,
  accumulator: AccumulatorParameter,
  wantsArray: boolean,
): boolean {
  const initial = skipOuterExpressionsOf(reduce.arguments[1]);
  if (wantsArray ? !ts.isArrayLiteralExpression(initial) : !ts.isObjectLiteralExpression(initial)) return false;
  return wantsArray || !typeScriptFile.test(reduce.getSourceFile().fileName) || typesAccumulator(reduce, accumulator);
}

function blockBodyFix(
  body: Block,
  returned: Node,
  lines: string[],
  text: string,
  wantsArray: boolean,
): FixResult | undefined {
  const statement = returned.parent;
  if (!ts.isReturnStatement(statement) || statement.parent !== body) return;
  const indentation = indentationAt(text, statement.getStart());
  return {
    edits: [
      {
        start: statement.getStart(),
        end: statement.end,
        text: lines.join(`\n${indentation}`),
      },
    ],
    note: accumulatorNote(wantsArray),
  };
}

function expressionBodyFix(
  body: Node,
  returned: Node,
  lines: string[],
  text: string,
  wantsArray: boolean,
): FixResult | undefined {
  if (returned !== body) return;
  const indentation = indentationAt(text, body.getStart());
  const inner = indentation + arrayCopyIndent;
  const indentedLines = lines.map((line) => inner + line);
  return {
    edits: [
      {
        start: body.getStart(),
        end: body.end,
        text: `{\n${indentedLines.join('\n')}\n${indentation}}`,
      },
    ],
    note: accumulatorNote(wantsArray),
  };
}

export function reduceCopyFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const site = findCopySpread(node);
  if (!site) return;
  const { literal, copiedSource } = site;
  const found = findReduceCallback(literal);
  if (!found) return;
  const { callback, reduce } = found;
  const accumulator = plainAccumulator(callback);
  if (!accumulator) return;
  const accumulatorName = accumulator.name;
  if (copiedSource.text !== accumulatorName || countNames(callback.body, accumulatorName) !== 1) return;
  const wantsArray = ts.isArrayLiteralExpression(literal);
  if (!initialValueAllowsRewrite(reduce, accumulator, wantsArray)) return;
  const statements = copiedAccumulatorStatements(literal, accumulatorName);
  if (!statements) return;
  const returned = outerParenthesized(literal);
  const text = callback.getSourceFile().text;
  const lines = [...statements, `return ${accumulatorName};`];
  const { body } = callback;
  return ts.isBlock(body)
    ? blockBodyFix(body, returned, lines, text, wantsArray)
    : expressionBodyFix(body, returned, lines, text, wantsArray);
}

function accumulatorNote(wantsArray: boolean): string {
  return wantsArray
    ? 'The accumulator is now one fresh array that is changed in place; the initial [] is created per reduce call.'
    : 'The accumulator is now one fresh object that is changed in place. A computed key of "__proto__" would set the prototype instead of an own property.';
}

function skipOuterExpressionsOf(node: Node): Node {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current))
    current = current.expression;
  return current;
}

function countNames(node: Node, name: string): number {
  let count = 0;
  (function visit(current: Node): void {
    if (ts.isIdentifier(current) && current.text === name) count++;
    ts.forEachChild(current, visit);
  })(node);
  return count;
}

function accumulatorDeclaration(
  assignment: BinaryExpression,
  name: string,
  wantsObject?: boolean,
): AccumulatorDeclaration | undefined {
  const scope = nearestFunctionOrFile(assignment);
  if (!scope) return;
  const declarations: VariableDeclaration[] = [];
  let valid = true;
  (function visit(current: Node): void {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.name.text === name) {
      declarations.push(current);
    }
    if (ts.isParameter(current) && bindingNames(current.name).includes(name)) valid = false;
    ts.forEachChild(current, visit);
  })(scope);
  const declaration = declarations.at(-1);
  if (!valid || declarations.length > 1 || !declaration || !ts.isVariableDeclarationList(declaration.parent)) return;
  if (nearestFunctionOrFile(declaration) !== scope || declaration.parent.flags & ts.NodeFlags.Const) return;
  const initial = declaration.initializer && skipOuterExpressionsOf(declaration.initializer);
  if (!initial || !(wantsObject ? plainObjectLiteral(initial) : ts.isArrayLiteralExpression(initial))) return;
  // An inferred `{}` type accepts the spread copy but rejects a keyed assignment.
  if (wantsObject && typeScriptFile.test(assignment.getSourceFile().fileName) && !declaration.type) return;
  return { declaration, scope };
}

// Spreading drops accessors and a literal `__proto__` prototype, so only plain data starts copy the
// same way.
function plainObjectLiteral(literal: Node): boolean {
  return (
    ts.isObjectLiteralExpression(literal) &&
    literal.properties.every(
      (property) =>
        ts.isSpreadAssignment(property) ||
        ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          (ts.isComputedPropertyName(property.name) || property.name.text !== '__proto__')),
    )
  );
}

// Every other use must be a read that cannot keep an earlier version of the array alive.
function onlyLocalReads(
  scope: Node,
  name: string,
  assignment: BinaryExpression,
  literal: ArrayLiteralExpression | ObjectLiteralExpression,
): boolean {
  let safe = true;
  (function visit(current: Node): void {
    if (!safe) return;
    if (ts.isIdentifier(current) && current.text === name && !bindsName(current)) {
      if (nearestFunctionOrFile(current) !== scope) safe = false;
      else if (!allowedAccumulatorUse(current, assignment, literal)) safe = false;
    }
    ts.forEachChild(current, visit);
  })(scope);
  return safe;
}

function allowedAccumulatorUse(identifier: Identifier, assignment: BinaryExpression, literal: Node): boolean {
  const { parent } = identifier;
  if (parent === assignment && assignment.left === identifier) return true;
  if (ts.isSpreadElement(parent) && ts.isArrayLiteralExpression(parent.parent)) return parent.parent === literal;
  if (ts.isSpreadAssignment(parent)) return parent.parent === literal;
  if (ts.isReturnStatement(parent)) return true;
  if (ts.isObjectLiteralExpression(literal)) return plainPropertyRead(identifier);
  if (ts.isPropertyAccessExpression(parent) && parent.expression === identifier) {
    return readOnlyArrayMembers.has(parent.name.text) && !parent.questionDotToken;
  }
  return false;
}

// `acc.key` or `acc[key]` read as a value: not written, deleted or called as a method that could
// see `this`.
function plainPropertyRead(identifier: Identifier): boolean {
  const access = identifier.parent;
  if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) return false;
  if (access.expression !== identifier || isAssignmentTarget(access)) return false;
  const consumer = outerParenthesized(access).parent;
  if (ts.isDeleteExpression(consumer)) return false;
  return !(ts.isCallExpression(consumer) && skipParentheses(consumer.expression) === access);
}

export function loopCopyFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const assignment = ancestor(node, ts.isBinaryExpression);
  if (!assignment || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
  if (!ts.isIdentifier(assignment.left) || !ts.isExpressionStatement(assignment.parent)) return;
  const name = assignment.left.text;
  const literal = skipParentheses(assignment.right);
  if (ts.isObjectLiteralExpression(literal)) return loopObjectCopyFix(assignment, literal, name);
  if (!ts.isArrayLiteralExpression(literal)) return;
  const [copied, ...added] = literal.elements;
  if (!copied || !ts.isSpreadElement(copied)) return;
  const copiedName = skipParentheses(copied.expression);
  if (!ts.isIdentifier(copiedName) || copiedName.text !== name) return;
  if (added.length === 0 || added.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element)))
    return;
  const found = accumulatorDeclaration(assignment, name);
  if (!found || !onlyLocalReads(found.scope, name, assignment, literal)) return;
  return {
    edits: [
      { start: assignment.getStart(), end: assignment.end, text: `${name}.push(${added.map(textOf).join(', ')})` },
    ],
    note: `${name} is only ever read, returned or extended here, so appending in place keeps the same result without copying it each time.`,
  };
}

// `acc = { ...acc, [key]: value }` becomes `acc[key] = value`. Several added keys are withheld
// because a later value could read a key the in-place version has already written.
function loopObjectCopyFix(
  assignment: BinaryExpression,
  literal: ObjectLiteralExpression,
  name: string,
): FixResult | undefined {
  const [copied, added, ...more] = literal.properties;
  if (!copied || !ts.isSpreadAssignment(copied) || !added || more.length > 0) return;
  const source = skipParentheses(copied.expression);
  if (!ts.isIdentifier(source) || source.text !== name) return;
  const statement = propertyTarget(added, name);
  if (!statement) return;
  const found = accumulatorDeclaration(assignment, name, true);
  if (!found || !onlyLocalReads(found.scope, name, assignment, literal)) return;
  return {
    edits: [{ start: assignment.getStart(), end: assignment.end, text: statement.slice(0, -1) }],
    note: `${name} is only ever read, returned or extended here, so assigning the key in place keeps the same result without copying it each time. A computed key of "__proto__" would set the prototype instead of an own property.`,
  };
}
