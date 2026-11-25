// Site fix for array-repeated-find: repeated find() calls by one key become a Map lookup.
import { ts, textOf, calleeCall, freshName } from './helpers.js';
import type { Block, CallExpression, Node, PropertyAccessExpression, SourceFile, Statement } from 'typescript';
import type { FixResult, SiteFixInput } from '../../shared/types.js';
import type { FindLookupFacts } from '../types/find-lookup-facts.js';
import type { LookupConstruction } from '../types/lookup-construction.js';
import {
  typeScriptFile,
  skipParentheses,
  declaresNameWithin,
  statementPlacement,
  outermostPlacement,
  onlyReadOnlyMembers,
  mentionsName,
  capitalize,
} from './collection-helpers.js';
import { lookupDeclarations } from './collection-lookup-declarations.js';

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

export function findFix({ node, sourceFile, finding }: SiteFixInput): FixResult | undefined {
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
