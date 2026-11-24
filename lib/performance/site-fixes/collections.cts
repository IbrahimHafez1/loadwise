// loadwise-reviewed large-module -- one registry of independent collection-rule builders (membership, find, lookups) that share the placement and lookup-declaration helpers; each builder stays beside the rule it proves
// Site fixes for collection rules. Each builder returns undefined unless the rewrite provably keeps
// behavior.
import {
  ts,
  textOf,
  ancestor,
  calleeCall,
  enclosingStatement,
  enclosingIteration,
  indentationAt,
  insertLinesBefore,
  freshName,
} from './helpers.cjs';
import { startsOwnLine } from './hoisting.cjs';
import type {
  ArrayLiteralExpression,
  ArrowFunction,
  BinaryExpression,
  Block,
  BindingName,
  CallExpression,
  FunctionExpression,
  Identifier,
  ImportDeclaration,
  Node,
  ObjectLiteralElementLike,
  ObjectLiteralExpression,
  PropertyAccessExpression,
  SignatureDeclaration,
  SourceFile,
  SpreadAssignment,
  SpreadElement,
  SyntaxKind,
  Statement,
  VariableDeclaration,
} from 'typescript';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.cjs';
import type { FindLookupFacts } from '../types/find-lookup-facts.cjs';

const typeScriptFile = /\.[cm]?tsx?$/;
const readOnlyArrayMembers = new Set(['length', 'includes', 'indexOf', 'at', 'join']);
// Array members that never change the array they are called on.
const nonMutatingMembers = new Set([
  ...readOnlyArrayMembers,
  'lastIndexOf',
  'map',
  'filter',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'forEach',
  'reduce',
  'reduceRight',
  'slice',
  'concat',
  'flat',
  'flatMap',
  'entries',
  'keys',
  'values',
  'toSorted',
  'toReversed',
  'toSpliced',
  'with',
]);
const arrayCopyIndent = '  ';

// Where a lookup is built: the code that then runs after it, that code's indentation, and the edits
// inserting the lines.
interface Placement {
  region: Node;
  indentation: string;
  edits: (...lines: string[]) => TextEdit[];
}

interface MembershipCall {
  call: CallExpression;
  receiver: Identifier | PropertyAccessExpression;
  root: Identifier;
  name: PropertyAccessExpression['name'];
}

interface BlockMembership {
  membership: MembershipCall;
  statement: Statement;
}

// The text around a lookup constructor: `new Set(` + array + calls + `)`.
interface LookupConstruction {
  open: string;
  array: string;
  calls: string[];
  close: string;
}

interface LookupDeclarations {
  declarations: string[];
  access: string;
}

interface KeyShape {
  parameterName: string;
  property: PropertyAccessExpression;
  key: Node;
  typedParameter: boolean;
}

interface BlockFind {
  call: CallExpression;
  shape: KeyShape;
  statement: Statement;
}

interface ExistenceRewrite {
  replaced: Node;
  negate: boolean;
}

interface ExtremeEnd {
  value: Node;
  last: boolean;
}

interface AccumulatorDeclaration {
  declaration: VariableDeclaration;
  scope: Node;
}

function skipParentheses(node: Node): Node {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function outerParenthesized(node: Node): Node {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return current;
}

function nearestFunctionOrFile(node: Node): SignatureDeclaration | SourceFile | undefined {
  return ancestor(
    node.parent,
    (current): current is SignatureDeclaration | SourceFile => ts.isFunctionLike(current) || ts.isSourceFile(current),
  );
}

function bindingNames(name: BindingName, names: string[] = []): string[] {
  if (ts.isIdentifier(name)) names.push(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
  return names;
}

function bindsName(identifier: Identifier): boolean {
  const { parent } = identifier;
  return (
    ((ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionLike(parent) ||
      ts.isClassLike(parent) ||
      ts.isImportSpecifier(parent)) &&
      parent.name === identifier) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportClause(parent)
  );
}

function declaresNameWithin(node: Node, name: string): boolean {
  let declared = false;
  (function visit(current: Node): void {
    if (declared) return;
    if (ts.isIdentifier(current) && current.text === name && bindsName(current)) declared = true;
    else ts.forEachChild(current, visit);
  })(node);
  return declared;
}

function importedNames(statement: ImportDeclaration): string[] {
  const clause = statement.importClause;
  if (!clause) return [];
  const names: string[] = [];
  if (clause.name) names.push(clause.name.text);
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
  else if (bindings) for (const specifier of bindings.elements) names.push(specifier.name.text);
  return names;
}

// Whether `name` resolves, at `statement`, to a binding that is safe to read earlier: a parameter,
// import, function, or `const` declared before the statement. Anything else (let, var, class, loop
// variables) is refused. Undefined lets the caller continue looking in the enclosing scope.
function bindingInStatements(statements: readonly Statement[], name: string, child: Node): boolean | undefined {
  for (const candidate of statements) {
    if (ts.isVariableStatement(candidate)) {
      const declares = candidate.declarationList.declarations.some((declaration) =>
        bindingNames(declaration.name).includes(name),
      );
      if (!declares) continue;
      return Boolean(candidate.declarationList.flags & ts.NodeFlags.Const) && candidate.end <= child.getStart();
    }
    if (ts.isFunctionDeclaration(candidate) && candidate.name?.text === name) return true;
    if (ts.isClassDeclaration(candidate) && candidate.name?.text === name) return false;
    if (ts.isImportDeclaration(candidate) && importedNames(candidate).includes(name)) return true;
  }
}

function boundBefore(statement: Statement, name: string): boolean {
  let child: Node = statement;
  for (let scope = statement.parent; scope; child = scope, scope = scope.parent) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
      const available = bindingInStatements(scope.statements, name, child);
      if (available !== undefined) return available;
    } else if (ts.isFunctionLike(scope)) {
      if (scope.parameters.some((parameter) => bindingNames(parameter.name).includes(name))) return true;
    } else if (
      (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
      scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some((declaration) => bindingNames(declaration.name).includes(name))
    ) {
      return false;
    } else if (ts.isCatchClause(scope) && scope.variableDeclaration) {
      if (bindingNames(scope.variableDeclaration.name).includes(name)) return false;
    }
  }
  return false;
}

// A callback of map/filter/some/... runs synchronously inside the statement that iterates.
function isIterationCallback(fn: SignatureDeclaration): boolean {
  const body = 'body' in fn ? fn.body : undefined;
  if (!body) return false;
  const iteration = enclosingIteration(body);
  return iteration?.kind === 'callback' && iteration.callback === fn;
}

function statementPlacement(statement: Statement, name: string): Placement | undefined {
  if (!startsOwnLine(statement) || declaresNameWithin(statement, name) || !boundBefore(statement, name)) return;
  return {
    region: statement,
    indentation: indentationAt(statement.getSourceFile().text, statement.getStart()),
    edits: (...lines: string[]) => [insertLinesBefore(statement, lines)],
  };
}

// An expression-bodied arrow function gets a block body that builds the lookup first and returns
// the expression.
function arrowPlacement(arrow: ArrowFunction, name: string): Placement | undefined {
  const { body } = arrow;
  const sourceFile = arrow.getSourceFile();
  const text = sourceFile.text;
  if (declaresNameWithin(body, name)) return;
  if (!arrow.parameters.some((parameter) => bindingNames(parameter.name).includes(name))) {
    const statement = enclosingStatement(arrow);
    if (!statement || declaresNameWithin(statement, name) || !boundBefore(statement, name)) return;
  }
  const arrowToken = arrow.equalsGreaterThanToken;
  const bodyStart = body.getStart(sourceFile);
  const gap = text.slice(arrowToken.end, bodyStart);
  if (gap.trim()) return;
  // A multi-line body that starts after `=>` would sit under-indented behind `return`.
  const bodyOnOwnLine = gap.includes('\n');
  if (!bodyOnOwnLine && text.slice(bodyStart, body.end).includes('\n')) return;
  const outer = indentationAt(text, arrowToken.getStart(sourceFile));
  const inner = bodyOnOwnLine ? indentationAt(text, bodyStart) : outer + arrayCopyIndent;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return {
    region: body,
    indentation: inner,
    edits: (...lines: string[]) => [
      {
        start: arrowToken.end,
        end: bodyStart,
        text: ` {${eol}${inner}${lines.join(eol + inner)}${eol}${inner}return `,
      },
      { start: body.end, end: body.end, text: `;${eol}${outer}}` },
    ],
  };
}

// Where a lookup of `name` can be built once for the iteration holding `node`: before the statement
// running the iteration, crossing only synchronous iteration callbacks, or at the top of an
// expression-bodied arrow function. Returns { region, indentation, edits(...lines) } where `region`
// is the code that now runs after the lookup is built.
function hoistPlacement(node: Node, name: string): Placement | undefined {
  const iteration = enclosingIteration(node);
  if (!iteration) return;
  const iterationNode = iteration.node;
  if (
    (ts.isForOfStatement(iterationNode) || ts.isForInStatement(iterationNode)) &&
    !ancestor(node, (current) => current === iterationNode.statement)
  )
    return;
  for (let current: Node = iterationNode; current; current = current.parent) {
    if (ts.isClassLike(current)) return;
    if (ts.isStatement(current) && (ts.isBlock(current.parent) || ts.isSourceFile(current.parent)))
      return statementPlacement(current, name);
    if (ts.isFunctionLike(current) && !isIterationCallback(current))
      return ts.isArrowFunction(current) && !ts.isBlock(current.body) ? arrowPlacement(current, name) : undefined;
  }
}

// Like hoistPlacement, then keeps moving out through enclosing iterations that never reassign or
// mutate `source` (rooted at `rootName`), so a nested loop builds the lookup once instead of once
// per outer item.
function outermostPlacement(node: Node, rootName: string, source: string): Placement | undefined {
  let placement = hoistPlacement(node, rootName);
  while (placement) {
    const outer = hoistPlacement(placement.region, rootName);
    if (!outer || !onlyReadOnlyMembers(outer.region, rootName, source)) return placement;
    placement = outer;
  }
}

// The identifier at the root of `a` or `a.b.c` without optional chaining, calls or element access.
function plainChainRoot(node: Node): Identifier | undefined {
  if (ts.isIdentifier(node)) return node;
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) return plainChainRoot(node.expression);
}

function isAssignmentTarget(node: Node): boolean {
  const { parent } = node;
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    const operator = parent.operatorToken.kind;
    return operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
  }
  return (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && parent.operand === node;
}

// Whether every use of `rootName` in `region` reads exactly `chainText` (such as
// `actor.permissions`), so reading that chain earlier cannot skip a guard like `existing && ...`
// written in the region.
function onlyReadThroughChain(region: Node, rootName: string, chainText: string): boolean {
  let safe = true;
  (function visit(current: Node): void {
    if (!safe) return;
    const { parent } = current;
    const isName = ts.isPropertyAccessExpression(parent) && parent.name === current;
    if (ts.isIdentifier(current) && current.text === rootName && !isName) {
      let chain: Node = current;
      while (textOf(chain) !== chainText && ts.isPropertyAccessExpression(chain.parent)) chain = chain.parent;
      if (textOf(chain) !== chainText || isAssignmentTarget(chain)) safe = false;
    } else ts.forEachChild(current, visit);
  })(region);
  return safe;
}

// A bare read of the chain root that only tests it, such as `existing && ...`, `!existing` or `if
// (existing)`.
function isTruthinessTest(identifier: Identifier): boolean {
  const node = outerParenthesized(identifier);
  const { parent } = node;
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    const isLogical = operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken;
    return parent.left === node && isLogical;
  }
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken;
  if (ts.isConditionalExpression(parent)) return parent.condition === node;
  return (ts.isIfStatement(parent) || ts.isWhileStatement(parent)) && parent.expression === node;
}

// Whether every use of `rootName` in `region` reads `chainText` or only tests the root, as in
// `existing && existing.items.includes(x)`. The lookup then reads the chain with `?.` so a missing
// root is no error.
function onlyGuardedChainReads(region: Node, rootName: string, chainText: string): boolean {
  let safe = true;
  (function visit(current: Node): void {
    if (!safe) return;
    const { parent } = current;
    const isName = ts.isPropertyAccessExpression(parent) && parent.name === current;
    if (ts.isIdentifier(current) && current.text === rootName && !isName) {
      if (isTruthinessTest(current)) return;
      let chain: Node = current;
      while (textOf(chain) !== chainText && ts.isPropertyAccessExpression(chain.parent)) chain = chain.parent;
      if (textOf(chain) !== chainText || isAssignmentTarget(chain)) safe = false;
    } else ts.forEachChild(current, visit);
  })(region);
  return safe;
}

// Whether every use of `rootName` in `region` reads `chainText` through a non-mutating array member
// such as
// `.includes()` or `.filter()`, or spreads it into a new array, so the array cannot change between
// the lookups.
function onlyReadOnlyMembers(region: Node, rootName: string, chainText: string): boolean {
  let safe = true;
  (function visit(current: Node): void {
    if (!safe) return;
    const { parent } = current;
    const isName = ts.isPropertyAccessExpression(parent) && parent.name === current;
    if (ts.isIdentifier(current) && current.text === rootName && !isName) {
      let chain: Node = current;
      while (textOf(chain) !== chainText && ts.isPropertyAccessExpression(chain.parent)) chain = chain.parent;
      const member = chain.parent;
      const readsMember =
        ts.isPropertyAccessExpression(member) &&
        member.expression === chain &&
        nonMutatingMembers.has(member.name.text);
      const spreadsCopy = ts.isSpreadElement(member) && ts.isArrayLiteralExpression(member.parent);
      if (textOf(chain) !== chainText || !(readsMember || spreadsCopy)) safe = false;
    } else ts.forEachChild(current, visit);
  })(region);
  return safe;
}

function membershipCall(node: Node): MembershipCall | undefined {
  if (!ts.isCallExpression(node) || ts.isOptionalChain(node) || !ts.isPropertyAccessExpression(node.expression)) return;
  const { expression: receiver, name } = node.expression;
  if (name.text !== 'includes' || node.arguments.length !== 1) return;
  if (!ts.isIdentifier(receiver) && !ts.isPropertyAccessExpression(receiver)) return;
  const root = plainChainRoot(receiver);
  return root && { call: node, receiver, root, name };
}

// Every `source.includes(x)` whose lookup would go before a statement of `block`, as { membership,
// statement }. One lookup then serves them all, and every finding among them gets the same fix, so
// applying one applies all.
function sameBlockMemberships(block: Block | SourceFile, source: string, rootName: string): BlockMembership[] {
  const found: BlockMembership[] = [];
  (function visit(current: Node): void {
    const membership = membershipCall(current);
    if (membership && textOf(membership.receiver) === source) {
      const statement = outermostPlacement(membership.call, rootName, source)?.region;
      if (statement && ts.isStatement(statement) && statement.parent === block) found.push({ membership, statement });
    }
    ts.forEachChild(current, visit);
  })(block);
  return found;
}

const maxLineLength = 100;

// `head` followed by `open array.calls() close;`, such as `const idsSet = new Set(ids);`. It stays
// on one line when that fits, otherwise the argument moves to its own line, and its chained calls
// one per line when still too long.
function constructionLines(
  indentation: string,
  head: string,
  { open, array, calls, close }: LookupConstruction,
): string[] {
  const width = (line: string): number => indentation.replaceAll('	', '    ').length + line.length;
  const oneLine = `${head}${open}${array}${calls.join('')}${close};`;
  if (width(oneLine) <= maxLineLength) return [oneLine];
  const unit = indentation.includes('\t') ? '\t' : arrayCopyIndent;
  const argument = `${unit}${array}${calls.join('')},`;
  const body =
    width(argument) <= maxLineLength || calls.length === 0
      ? [argument]
      : [
          `${unit}${array}`,
          ...calls.map((call, index) => unit + unit + call + (index === calls.length - 1 ? ',' : '')),
        ];
  return [`${head}${open}`, ...body, `${close};`];
}

// An eager lookup is a plain `const` built right before the iteration. A lazy one is declared there
// but built on the first lookup, for when building early could throw, run a getter, or see the
// array before code in the iteration changes it.
function lookupDeclarations(
  sourceFile: SourceFile,
  name: string,
  placement: Placement,
  construction: LookupConstruction,
  eager: boolean,
): LookupDeclarations | undefined {
  if (eager) {
    return { declarations: constructionLines(placement.indentation, `const ${name} = `, construction), access: name };
  }
  const factory = freshName(sourceFile, 'build' + capitalize(name));
  if (!factory) return;
  let returnType = 'ReturnType';
  if (mentionsName(sourceFile, returnType)) {
    if (mentionsName(sourceFile, 'globalThis')) return;
    returnType = 'globalThis.ReturnType';
  }
  const type = `${returnType}<typeof ${factory}>`;
  const declaration = typeScriptFile.test(sourceFile.fileName)
    ? `let ${name}: ${type};`
    : `/** @type {${type}} */ let ${name};`;
  return {
    declarations: [...constructionLines(placement.indentation, `const ${factory} = () => `, construction), declaration],
    access: `(${name} ??= ${factory}())`,
  };
}

function lastPropertyName(receiver: Identifier | PropertyAccessExpression): string {
  return ts.isIdentifier(receiver) ? receiver.text : receiver.name.text;
}

// A chain such as `team.members` names its Set after the last property, unless another membership
// check in the file reads a different array with that name: then the whole chain names it, so two
// Sets never share a name.
function chainSetBase(sourceFile: SourceFile, receiver: Identifier | PropertyAccessExpression): string {
  const source = textOf(receiver);
  const last = lastPropertyName(receiver);
  let clash = false;
  (function visit(current: Node): void {
    if (clash) return;
    const other = membershipCall(current);
    if (other && lastPropertyName(other.receiver) === last && textOf(other.receiver) !== source) clash = true;
    else ts.forEachChild(current, visit);
  })(sourceFile);
  if (!clash) return last;
  return source
    .replaceAll(/\s/g, '')
    .split('.')
    .map((part, index) => (index ? capitalize(part) : part))
    .join('');
}

// loadwise-reviewed high-branch-complexity -- a linear chain of independent safety bail-outs (receiver, name, placement, chain reads) before a single Set rewrite; splitting scatters the proof from the edit it guards
function membershipFix({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const flagged = calleeCall(node);
  const membership = flagged && membershipCall(flagged);
  if (!membership || declaresNameWithin(sourceFile, 'Set')) return;
  const { call, receiver, root } = membership;
  const chained = receiver !== root;
  const source = textOf(receiver);
  const setName = freshName(sourceFile, `${chained ? chainSetBase(sourceFile, receiver) : root.text}Set`);
  if (!setName) return;
  let placement = outermostPlacement(call, root.text, source);
  if (!placement) return;
  let calls: MembershipCall[] = [membership];
  let covered: readonly Node[] = [placement.region];
  const block = placement.region.parent;
  if (ts.isStatement(placement.region) && (ts.isBlock(block) || ts.isSourceFile(block))) {
    const group = sameBlockMemberships(block, source, root.text);
    if (group.length > 1) {
      const statements = block.statements;
      const first = statements.indexOf(group[0].statement);
      const last = statements.indexOf(group[group.length - 1].statement);
      covered = statements.slice(first, last + 1);
      if (!covered.every((statement) => onlyReadOnlyMembers(statement, root.text, source))) return;
      placement = statementPlacement(group[0].statement, root.text);
      if (!placement) return;
      calls = group.map((entry) => entry.membership);
    }
  }
  let built = source;
  if (chained && !onlyReadThroughChain(placement.region, root.text, source)) {
    const rest = source.slice(root.text.length);
    if (calls.length > 1 || !/^\.[\w$.]+$/.test(rest)) return;
    if (!onlyGuardedChainReads(placement.region, root.text, source)) return;
    built = `${root.text}?${rest}`;
  }
  // A plain name that the iteration never changes can be read early: `new Set()` accepts any array,
  // null or undefined. A property chain stays lazy because reading it early could run a getter or
  // reach a root that the original code only reads behind a guard.
  const eager = !chained && covered.every((region) => onlyReadOnlyMembers(region, root.text, source));
  const construction: LookupConstruction = { open: 'new Set(', array: built, calls: [], close: ')' };
  const lookup = lookupDeclarations(sourceFile, setName, placement, construction, eager);
  if (!lookup) return;
  return {
    edits: [
      ...placement.edits(...lookup.declarations),
      ...calls.map((each) => ({
        start: each.receiver.getStart(),
        end: each.name.end,
        text: `${lookup.access}.has`,
      })),
    ],
    note: eager
      ? `The Set is built once before the iteration. This assumes \`${source}\` stays unchanged while it runs.`
      : `The Set is built on the first membership check. This assumes \`${source}\` stays unchanged between checks.`,
  };
}

function lookupKeyShape(call: CallExpression): KeyShape | undefined {
  if (call.arguments.length !== 1 || ts.isOptionalChain(call)) return;
  const callback = skipParentheses(call.arguments[0]);
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return;
  if (callback.asteriskToken || callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
    return;
  const [parameter] = callback.parameters;
  if (callback.parameters.length !== 1 || !ts.isIdentifier(parameter.name) || parameter.initializer) return;
  if (parameter.dotDotDotToken) return;
  let body: Node | undefined = callback.body;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0])) return;
    body = body.statements[0].expression;
    if (!body) return;
  }
  const comparison = skipParentheses(body);
  if (!ts.isBinaryExpression(comparison) || comparison.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken)
    return;
  const parameterName = parameter.name.text;
  const sides = [skipParentheses(comparison.left), skipParentheses(comparison.right)];
  const propertySides = sides.filter((side): side is PropertyAccessExpression =>
    propertyOfParameter(side, parameterName),
  );
  if (propertySides.length !== 1) return;
  const [property] = propertySides;
  const key = sides.find((side) => side !== property);
  if (!key || !pureKey(key) || mentionsName(key, parameterName)) return;
  return { parameterName, property, key, typedParameter: Boolean(parameter.type) };
}

function propertyOfParameter(node: Node, parameterName: string): node is PropertyAccessExpression {
  if (!ts.isPropertyAccessExpression(node) || node.questionDotToken) return false;
  const root = node.expression;
  if (ts.isIdentifier(root)) return root.text === parameterName;
  return propertyOfParameter(root, parameterName);
}

function pureKey(node: Node): boolean {
  const value = skipParentheses(node);
  if (ts.isIdentifier(value) || value.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)) return true;
  if (ts.isPropertyAccessExpression(value) || ts.isNonNullExpression(value)) return pureKey(value.expression);
  if (ts.isElementAccessExpression(value)) return pureKey(value.expression) && pureKey(value.argumentExpression);
  return false;
}

function mentionsName(node: Node, name: string): boolean {
  let found = false;
  (function visit(current: Node): void {
    if (found) return;
    if (ts.isIdentifier(current) && current.text === name) found = true;
    else ts.forEachChild(current, visit);
  })(node);
  return found;
}

function capitalize(text: string): string {
  return text[0].toUpperCase() + text.slice(1);
}

// The key path after the callback parameter, such as `.id` for `(item) => item.id === key`.
function keyPathOf(shape: KeyShape): string {
  return textOf(shape.property).slice(shape.parameterName.length).replaceAll(/\s/g, '');
}

function receiverFind(node: Node, receiverText: string): KeyShape | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
  const { expression: receiver, name } = node.expression;
  if (name.text !== 'find' || !ts.isIdentifier(receiver) || receiver.text !== receiverText) return;
  return lookupKeyShape(node);
}

// The Map is named after the last key property, unless another find() on the array uses a different
// path ending in that property: then the whole path names it, so two Maps never share a name.
function findKeyName(sourceFile: SourceFile, receiverText: string, shape: KeyShape): string {
  const path = keyPathOf(shape);
  const last = shape.property.name.text;
  let clash = false;
  (function visit(current: Node): void {
    if (clash) return;
    const other = receiverFind(current, receiverText);
    if (other && other.property.name.text === last && keyPathOf(other) !== path) clash = true;
    else ts.forEachChild(current, visit);
  })(sourceFile);
  return clash ? path.split('.').slice(1).map(capitalize).join('') : capitalize(last);
}

// Every `receiver.find()` by the same key path whose lookup would go before a statement of `block`,
// as { call, shape, statement }. One Map serves them all, and each of their findings gets the same
// fix.
function sameBlockFinds(block: Block | SourceFile, receiverText: string, path: string): BlockFind[] {
  const found: BlockFind[] = [];
  (function visit(current: Node): void {
    const shape = receiverFind(current, receiverText);
    if (shape && ts.isCallExpression(current) && keyPathOf(shape) === path) {
      const statement = outermostPlacement(current, receiverText, receiverText)?.region;
      if (statement && ts.isStatement(statement) && statement.parent === block)
        found.push({ call: current, shape, statement });
    }
    ts.forEachChild(current, visit);
  })(block);
  return found;
}

// The `new Map(...)` indexing the array by the first lookup's key. `.reverse()` makes the first
// duplicate win, as in find(). The NaN filter stays only for keys that can be NaN, which a
// strict-equality find() never matches.
function mapConstruction(
  sourceFile: SourceFile,
  receiverText: string,
  shape: KeyShape,
  facts: FindLookupFacts,
): LookupConstruction {
  const typed = typeScriptFile.test(sourceFile.fileName);
  const { parameterName, property } = shape;
  const pair = `[${textOf(property)}, ${parameterName}]`;
  const entry = typed ? `${pair} as const` : `/** @type {const} */ (${pair})`;
  const calls = [`.map((${parameterName}) => ${entry})`];
  if (facts.numericKey) calls.push('.filter(([key]) => !Number.isNaN(key))');
  calls.push('.reverse()');
  // `new Map(entries)` infers the stored key type, which must accept every probe passed to get().
  if (facts.inferKey && !shape.typedParameter) return { open: 'new Map(', array: receiverText, calls, close: ')' };
  const mapType = `Map<${facts.keyType}, (typeof ${receiverText})[number]>`;
  return typed
    ? { open: `new ${mapType}(`, array: receiverText, calls, close: ')' }
    : { open: `/** @type {${mapType}} */ (new Map(`, array: receiverText, calls, close: '))' };
}

function isFindLookupFacts(value: unknown): value is FindLookupFacts {
  return (
    typeof value === 'object' &&
    value !== null &&
    'keyType' in value &&
    'inferKey' in value &&
    'numericKey' in value &&
    'eager' in value
  );
}

// loadwise-reviewed high-branch-complexity -- a linear chain of independent safety bail-outs (facts, receiver, key shape, placement, eager reads) before a single Map rewrite; splitting scatters the proof from the edit it guards
function findFix({ node, sourceFile, finding }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const facts = finding.findLookup;
  if (finding.narrowsFindResult || !isFindLookupFacts(facts)) return;
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'find') return;
  const receiver = call.expression.expression;
  if (!ts.isIdentifier(receiver)) return;
  const shape = lookupKeyShape(call);
  if (!shape || declaresNameWithin(sourceFile, 'Number') || declaresNameWithin(sourceFile, 'Map')) return;
  const name = receiver.text;
  const mapName = freshName(sourceFile, `${name}By${findKeyName(sourceFile, name, shape)}`);
  if (!mapName) return;
  let placement = outermostPlacement(call, name, name);
  if (!placement) return;
  let lookups: { call: CallExpression; shape: KeyShape }[] = [{ call, shape }];
  let covered: readonly Node[] = [placement.region];
  const block = placement.region.parent;
  if (ts.isStatement(placement.region) && (ts.isBlock(block) || ts.isSourceFile(block))) {
    const group = sameBlockFinds(block, name, keyPathOf(shape));
    if (group.length > 1) {
      const statements = block.statements;
      const first = statements.indexOf(group[0].statement);
      const last = statements.indexOf(group[group.length - 1].statement);
      covered = statements.slice(first, last + 1);
      if (!covered.every((statement) => onlyReadOnlyMembers(statement, name, name))) return;
      placement = statementPlacement(group[0].statement, name);
      if (!placement) return;
      lookups = group;
    }
  }
  // Building early reads every key, so it needs non-nullish elements and plain key properties
  // (facts.eager), and an array that the iteration leaves unchanged. Otherwise the Map is built on
  // the first lookup.
  const eager = facts.eager && covered.every((region) => onlyReadOnlyMembers(region, name, name));
  const construction = mapConstruction(sourceFile, name, lookups[0].shape, facts);
  const lookup = lookupDeclarations(sourceFile, mapName, placement, construction, eager);
  if (!lookup) return;
  const matching = facts.numericKey ? 'NaN keys are skipped and the first duplicate wins' : 'The first duplicate wins';
  return {
    edits: [
      ...placement.edits(...lookup.declarations),
      ...lookups.map((each) => ({
        start: each.call.getStart(),
        end: each.call.end,
        text: `${lookup.access}.get(${textOf(each.shape.key)})`,
      })),
    ],
    note: eager
      ? `The Map is built once before the iteration. ${matching}, as with a strict-equality find(). This assumes stable keys and that \`${name}\` stays unchanged while the iteration runs.`
      : `The Map is built on the first lookup. ${matching}, as with a strict-equality find(). This assumes stable, side-effect-free keys, an unchanged array and non-null elements.`,
  };
}

// Whether `length <op> threshold` (or the mirrored form) holds exactly when the array is non-empty
// (true), exactly when it is empty (false), or neither (undefined).
function lengthComparisonPositive(kind: SyntaxKind, threshold: number, lengthOnLeft: boolean): boolean | undefined {
  if (threshold === 0) {
    const zeroTable: Record<number, boolean | undefined> = {
      [ts.SyntaxKind.ExclamationEqualsEqualsToken]: true,
      [ts.SyntaxKind.ExclamationEqualsToken]: true,
      [ts.SyntaxKind.EqualsEqualsEqualsToken]: false,
      [ts.SyntaxKind.EqualsEqualsToken]: false,
      [ts.SyntaxKind.GreaterThanToken]: lengthOnLeft ? true : undefined,
      [ts.SyntaxKind.LessThanToken]: lengthOnLeft ? undefined : true,
      [ts.SyntaxKind.LessThanEqualsToken]: lengthOnLeft ? false : undefined,
      [ts.SyntaxKind.GreaterThanEqualsToken]: lengthOnLeft ? undefined : false,
    };
    return zeroTable[kind];
  }
  if (threshold === 1) {
    const oneTable: Record<number, boolean | undefined> = {
      [ts.SyntaxKind.GreaterThanEqualsToken]: lengthOnLeft ? true : undefined,
      [ts.SyntaxKind.LessThanEqualsToken]: lengthOnLeft ? undefined : true,
      [ts.SyntaxKind.LessThanToken]: lengthOnLeft ? false : undefined,
      [ts.SyntaxKind.GreaterThanToken]: lengthOnLeft ? undefined : false,
    };
    return oneTable[kind];
  }
  return undefined;
}

function comparisonExistenceRewrite(
  length: PropertyAccessExpression,
  comparison: BinaryExpression,
): ExistenceRewrite | undefined {
  const lengthOnLeft = comparison.left === length;
  const other = lengthOnLeft ? comparison.right : comparison.left;
  if (!ts.isNumericLiteral(other)) return;
  const positive = lengthComparisonPositive(comparison.operatorToken.kind, Number(other.text), lengthOnLeft);
  if (positive === undefined) return;
  return { replaced: comparison, negate: !positive };
}

function isLogicalOperation(node: Node): boolean {
  return (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  );
}

function isStatementCondition(consumer: Node, expression: Node): boolean {
  return (
    ((ts.isIfStatement(consumer) || ts.isWhileStatement(consumer) || ts.isDoStatement(consumer)) &&
      consumer.expression === expression) ||
    ((ts.isConditionalExpression(consumer) || ts.isForStatement(consumer)) && consumer.condition === expression)
  );
}

// The rule only reports `Boolean(...)` after resolving it to the built-in conversion.
function isBooleanConversionArgument(consumer: Node, expression: Node): boolean {
  return (
    ts.isCallExpression(consumer) &&
    consumer.arguments.length === 1 &&
    consumer.arguments[0] === expression &&
    ts.isIdentifier(consumer.expression) &&
    consumer.expression.text === 'Boolean'
  );
}

function existenceRewrite(length: PropertyAccessExpression): ExistenceRewrite | undefined {
  const parent = length.parent;
  if (ts.isBinaryExpression(parent)) return comparisonExistenceRewrite(length, parent);
  let expression: Node = length;
  while (isLogicalOperation(expression.parent)) expression = expression.parent;
  const consumer = expression.parent;
  const inCondition =
    isStatementCondition(consumer, expression) ||
    (ts.isPrefixUnaryExpression(consumer) && consumer.operator === ts.SyntaxKind.ExclamationToken) ||
    isBooleanConversionArgument(consumer, expression);
  return inCondition ? { replaced: length, negate: false } : undefined;
}

function filterExistenceFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'filter') return;
  if (call.arguments.length !== 1 || ts.isOptionalChain(call)) return;
  const length = call.parent;
  if (!ts.isPropertyAccessExpression(length) || length.expression !== call || length.name.text !== 'length') return;
  if (length.questionDotToken) return;
  const rewrite = existenceRewrite(length);
  if (!rewrite) return;
  const { replaced, negate } = rewrite;
  const edits: TextEdit[] = [{ start: call.expression.name.getStart(), end: call.expression.name.end, text: 'some' }];
  if (replaced === length) edits.push({ start: call.end, end: length.end, text: '' });
  else {
    edits.push({ start: replaced.getStart(), end: length.getStart(), text: negate ? '!' : '' });
    edits.push({ start: call.end, end: replaced.end, text: '' });
  }
  return {
    edits,
    note: 'some() stops at the first match, so the predicate must not rely on running for every element.',
  };
}

function comparatorDirection(compare: Node): { ascending: boolean } | undefined {
  const callback = skipParentheses(compare);
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return;
  if (callback.parameters.length !== 2) return;
  const [first, second] = callback.parameters;
  if (!ts.isIdentifier(first.name) || !ts.isIdentifier(second.name)) return;
  let body: Node | undefined = callback.body;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0])) return;
    body = body.statements[0].expression;
    if (!body) return;
  }
  const result = skipParentheses(body);
  if (!ts.isBinaryExpression(result) || result.operatorToken.kind !== ts.SyntaxKind.MinusToken) return;
  const left = skipParentheses(result.left);
  const right = skipParentheses(result.right);
  if (!ts.isIdentifier(left) || !ts.isIdentifier(right) || left.text === right.text) return;
  if (left.text === first.name.text && right.text === second.name.text) return { ascending: true };
  if (left.text === second.name.text && right.text === first.name.text) return { ascending: false };
}

function sortedArraySource(method: string, receiver: Node): Node | undefined {
  if (method === 'toSorted') return receiver;
  if (ts.isArrayLiteralExpression(receiver) && receiver.elements.length === 1) {
    const [only] = receiver.elements;
    return ts.isSpreadElement(only) ? skipParentheses(only.expression) : undefined;
  }
  if (
    ts.isCallExpression(receiver) &&
    receiver.arguments.length === 1 &&
    ts.isPropertyAccessExpression(receiver.expression) &&
    receiver.expression.name.text === 'from' &&
    ts.isIdentifier(receiver.expression.expression) &&
    receiver.expression.expression.text === 'Array'
  )
    return skipParentheses(receiver.arguments[0]);
}

// The element access or `.at()` call that reads one end of the sorted copy.
function readEnd(sortCall: CallExpression): ExtremeEnd | undefined {
  const sorted = outerParenthesized(sortCall);
  const access = sorted.parent;
  if (ts.isElementAccessExpression(access) && access.expression === sorted && !access.questionDotToken) {
    const index = skipParentheses(access.argumentExpression);
    return ts.isNumericLiteral(index) && Number(index.text) === 0 ? { value: access, last: false } : undefined;
  }
  if (!ts.isPropertyAccessExpression(access) || access.expression !== sorted || access.name.text !== 'at') return;
  const lookup = access.parent;
  if (!ts.isCallExpression(lookup) || lookup.expression !== access || lookup.arguments.length !== 1) return;
  const index = skipParentheses(lookup.arguments[0]);
  if (ts.isNumericLiteral(index) && Number(index.text) === 0) return { value: lookup, last: false };
  if (
    ts.isPrefixUnaryExpression(index) &&
    index.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(index.operand) &&
    Number(index.operand.text) === 1
  )
    return { value: lookup, last: true };
}

function sortExtremeFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.arguments.length !== 1) return;
  const method = call.expression.name.text;
  if (method !== 'sort' && method !== 'toSorted') return;
  const source = sortedArraySource(method, skipParentheses(call.expression.expression));
  if (!source || !ts.isIdentifier(source)) return;
  const order = comparatorDirection(call.arguments[0]);
  const end = readEnd(call);
  if (!order || !end) return;
  const wantsMinimum = order.ascending !== end.last;
  // A tie keeps the element the stable sort would have put at that end: the first one for index 0,
  // the last for -1.
  const comparison = (wantsMinimum ? '<' : '>') + (end.last ? '=' : '');
  const best = wantsMinimum ? 'min' : 'max';
  const array = source.text;
  return {
    edits: [
      {
        start: end.value.getStart(),
        end: end.value.end,
        text: `${array}.reduce((${best}, value) => (value ${comparison} ${best} ? value : ${best}), ${array}[0])`,
      },
    ],
    note: 'One pass, no copy and no spread limit; an empty array still gives undefined. Like the sort, this assumes plain numbers without NaN or holes.',
  };
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

function reduceCopyFix({ node }: SiteFixInput): FixResult | undefined {
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

function loopCopyFix({ node }: SiteFixInput): FixResult | undefined {
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

function rebuildLookupFix({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const constructed = ancestor(node, ts.isNewExpression);
  if (!constructed || constructed.getStart() !== node.getStart() || !ts.isIdentifier(constructed.expression)) return;
  const kind = constructed.expression.text;
  if (kind !== 'Map' && kind !== 'Set') return;
  if (constructed.arguments?.length !== 1) return;
  const source = skipParentheses(constructed.arguments[0]);
  const use = outerParenthesized(constructed).parent;
  if (!ts.isIdentifier(source) || !ts.isPropertyAccessExpression(use)) return;
  const lookupName = freshName(sourceFile, `${source.text}${kind}`);
  if (!lookupName) return;
  const placement = hoistPlacement(constructed, source.text);
  if (!placement) return;
  return {
    edits: [
      ...placement.edits(`const ${lookupName} = new ${kind}(${source.text});`),
      { start: constructed.getStart(), end: constructed.end, text: lookupName },
    ],
    note: `${source.text} must not change while the iteration runs; ${lookupName} is a snapshot taken before it.`,
  };
}

function promiseCombinatorFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const call = calleeCall(node);
  if (!call || call.arguments.length !== 1) return;
  const [list] = call.arguments;
  if (!ts.isArrayLiteralExpression(list)) return;
  const edits: TextEdit[] = [];
  for (const element of list.elements) {
    const awaited = skipParentheses(element);
    if (!ts.isAwaitExpression(awaited)) return;
    edits.push({ start: awaited.getStart(), end: awaited.expression.getStart(), text: '' });
  }
  return {
    edits,
    note: 'The calls now start together. Check that none depends on another finishing first, and that an earlier rejection should not stop later calls from running.',
  };
}

function knownReadsFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const awaited = ancestor(node, ts.isAwaitExpression);
  if (!awaited) return;
  const declaration = awaited.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return;
  const statement = declaration.parent.parent;
  const block = statement.parent;
  if (!ts.isVariableStatement(statement) || !(ts.isBlock(block) || ts.isSourceFile(block))) return;
  const index = block.statements.indexOf(statement);
  const previous = block.statements[index - 1];
  if (!previous || !ts.isVariableStatement(previous)) return;
  const first = previous.declarationList.declarations[0];
  if (
    previous.modifiers ||
    statement.modifiers ||
    previous.declarationList.declarations.length !== 1 ||
    !(previous.declarationList.flags & ts.NodeFlags.Const) ||
    !(statement.declarationList.flags & ts.NodeFlags.Const) ||
    !ts.isIdentifier(first.name) ||
    first.type ||
    declaration.type ||
    !first.initializer ||
    !ts.isAwaitExpression(first.initializer)
  )
    return;
  const sourceText = statement.getSourceFile().text;
  if (sourceText.slice(previous.end, statement.getStart()).trim()) return;
  if (mentionsName(awaited.expression, first.name.text)) return;
  const names = `${first.name.text}, ${declaration.name.text}`;
  const calls = `${textOf(first.initializer.expression)}, ${textOf(awaited.expression)}`;
  return {
    edits: [
      {
        start: previous.getStart(),
        end: statement.end,
        text: `const [${names}] = await Promise.all([${calls}]);`,
      },
    ],
    note: 'Both reads start together; if the first rejects, the second still runs to completion.',
  };
}

export default {
  'array-repeated-membership': membershipFix,
  'array-repeated-find': findFix,
  'filter-for-existence': filterExistenceFix,
  'numeric-sort-for-extreme': sortExtremeFix,
  'reduce-copy-accumulator': reduceCopyFix,
  'loop-copy-accumulator': loopCopyFix,
  'rebuild-lookup-in-loop': rebuildLookupFix,
  'promise-combinator-serial-await': promiseCombinatorFix,
  'known-reads-awaited-serially': knownReadsFix,
};
