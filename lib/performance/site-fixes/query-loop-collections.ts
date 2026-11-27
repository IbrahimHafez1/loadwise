// What a loop's collection is (array or iterable, fixed or not) and how to map a per-item expression
// over it, as `.map` or `Array.from`.
import { ts, textOf, isPlainReference } from './helpers.js';
import type {
  ArrayBindingElement,
  BindingElement,
  Expression,
  Identifier,
  Node,
  ParameterDeclaration,
  TypeNode,
  VariableDeclaration,
  VariableStatement,
} from 'typescript';
import { mentions } from './query-loop-nodes.js';
import type { ForOfLoopBinding } from '../types/loop-lookup.js';

/** The pattern and collection a per-item expression is mapped over. */
type MapBinding = Pick<ForOfLoopBinding, 'pattern' | 'source'>;

const arrayProducingMethods = new Set(['map', 'filter', 'slice', 'concat', 'flatMap', 'toSorted', 'split']);

const awaitedListMethods = new Set(['findMany', 'find', 'findBy', 'findAll']);

const arrayTypeNames = new Set(['Array', 'ReadonlyArray']);

// Array.from would drain these before the loop runs, leaving the loop nothing to iterate.
const oneShotTypeNames = new Set([
  'Iterable',
  'IterableIterator',
  'Iterator',
  'Generator',
  'AsyncIterable',
  'AsyncIterableIterator',
  'AsyncGenerator',
]);

// `[open, close]` around a per-item expression so it is evaluated once for every item of the loop.
// The names of an array pattern of two plain identifiers, or undefined for any other pattern.
function plainPairNames(elements: readonly ArrayBindingElement[]): [string, string] | undefined {
  if (elements.length !== 2) return;
  const names: string[] = [];
  for (const element of elements) {
    if (
      ts.isOmittedExpression(element) ||
      !ts.isIdentifier(element.name) ||
      element.initializer ||
      element.dotDotDotToken
    )
      return;
    names.push(element.name.text);
  }
  return [names[0], names[1]];
}

export function mapParts(binding: MapBinding, result: string): [string, string] {
  const { pattern, source } = binding;
  if (ts.isIdentifier(pattern)) {
    return source.kind === 'array'
      ? [`${source.text}.map((${pattern.text}) => `, ')']
      : [`Array.from(${source.text}, (${pattern.text}) => `, ')'];
  }
  const elements: readonly ArrayBindingElement[] = ts.isArrayBindingPattern(pattern) ? pattern.elements : [];
  const plainPair = plainPairNames(elements);
  if (source.method === 'entries' && source.ownerKind === 'array' && plainPair) {
    const [index, item] = plainPair;
    // An unused item keeps its slot with a leading underscore so unused-parameter checks stay
    // quiet.
    const parameters = mentions(result, index) ? `${mentions(result, item) ? item : `_${item}`}, ${index}` : item;
    return [`${source.owner}.map((${parameters}) => `, ')'];
  }
  const parameter = elements.length ? arrayParameter(elements, result) : textOf(pattern);
  if (source.kind === 'array') return [`${source.text}.map((${parameter}) => `, ')'];
  return [`Array.from(${source.text}, (${parameter}) => `, ')'];
}

// An array pattern whose names `result` never reads become holes, so the callback declares nothing
// it ignores.
function arrayParameter(elements: readonly ArrayBindingElement[], result: string): string {
  const kept = elements.map((element) => {
    const plainName =
      !ts.isOmittedExpression(element) &&
      ts.isIdentifier(element.name) &&
      !element.initializer &&
      !element.dotDotDotToken;
    return plainName && !mentions(result, element.name.text) ? '' : textOf(element);
  });
  while (kept.length && !kept.at(-1)) kept.pop();
  return `[${kept.join(', ')}]`;
}

// `result` evaluated for every item of the loop, as an array.
export function mapItems(binding: MapBinding, result: string): string {
  if (ts.isIdentifier(binding.pattern) && result === binding.pattern.text)
    return binding.source.kind === 'array' ? binding.source.text : `Array.from(${binding.source.text})`;
  const [open, close] = mapParts(binding, result);
  return `${open}${result.startsWith('{') ? `(${result})` : result}${close}`;
}

function typeKind(type: TypeNode): 'array' | 'iterable' | undefined {
  if (ts.isArrayTypeNode(type) || ts.isTupleTypeNode(type)) return 'array';
  if (ts.isTypeOperatorNode(type)) return typeKind(type.type);
  if (!ts.isTypeReferenceNode(type)) return 'iterable';
  const name = textOf(type.typeName);
  if (arrayTypeNames.has(name)) return 'array';
  if (!oneShotTypeNames.has(name)) return 'iterable';
}

function declarationOf(
  identifier: Identifier,
): ParameterDeclaration | VariableDeclaration | BindingElement | undefined {
  const name = identifier.text;
  for (let scope: Node = identifier.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const parameter = scope.parameters.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
      );
      if (parameter) return parameter;
    }
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const declared = declarationNamed(statement, name);
      if (declared) return declared;
    }
  }
}

// The declaration or destructured element in `statement` that binds `name`.
function declarationNamed(
  statement: VariableStatement,
  name: string,
): VariableDeclaration | BindingElement | undefined {
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
    if (!ts.isObjectBindingPattern(declaration.name)) continue;
    const element = declaration.name.elements.find((item) => ts.isIdentifier(item.name) && item.name.text === name);
    if (element) return element;
  }
}

function isArrayExpression(expression: Expression): boolean {
  const value = ts.skipParentheses(expression);
  if (ts.isArrayLiteralExpression(value)) return true;
  if (ts.isAwaitExpression(value)) {
    const call = ts.skipParentheses(value.expression);
    return (
      ts.isCallExpression(call) &&
      ts.isPropertyAccessExpression(call.expression) &&
      awaitedListMethods.has(call.expression.name.text)
    );
  }
  if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) return false;
  const callee = textOf(value.expression);
  return (
    arrayProducingMethods.has(value.expression.name.text) ||
    ['Array.from', 'Array.of', 'Object.keys', 'Object.values', 'Object.entries'].includes(callee)
  );
}

// 'array' when `.map` exists, 'iterable' when Array.from copies it safely, undefined when it may be
// one-shot.
export function collectionKind(expression: Expression): 'array' | 'iterable' | undefined {
  if (!ts.isIdentifier(expression)) return 'iterable';
  const declaration = declarationOf(expression);
  if (!declaration) return 'iterable';
  if (ts.isBindingElement(declaration)) {
    const bindingKey = declaration.propertyName ?? declaration.name;
    const name =
      ts.isComputedPropertyName(bindingKey) ||
      ts.isObjectBindingPattern(bindingKey) ||
      ts.isArrayBindingPattern(bindingKey)
        ? undefined
        : bindingKey.text;
    const source = declaration.parent.parent;
    const initializer =
      ts.isVariableDeclaration(source) && source.initializer && ts.skipParentheses(source.initializer);
    const call = initializer && ts.isAwaitExpression(initializer) && ts.skipParentheses(initializer.expression);
    const pgRows =
      name === 'rows' &&
      call &&
      ts.isCallExpression(call) &&
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === 'query';
    return pgRows ? 'array' : undefined;
  }
  if (declaration.type) return typeKind(declaration.type);
  if (ts.isParameter(declaration)) return 'iterable';
  if (!declaration.initializer) return;
  if (isArrayExpression(declaration.initializer)) return 'array';
  const initializer = ts.skipParentheses(declaration.initializer);
  if (ts.isNewExpression(initializer) && ['Set', 'Map'].includes(textOf(initializer.expression))) return 'iterable';
  if (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)) return typeKind(initializer.type);
}

// A list whose items are fixed in the source (`const PLANS = [...]` or an imported SCREAMING_CASE
// constant), so a reader can check that its keys are distinct.
export function fixedList(expression: Expression): boolean {
  const value = ts.skipParentheses(expression);
  if (ts.isPropertyAccessExpression(value)) return isPlainReference(value) && fixedList(value.expression);
  if (!ts.isIdentifier(value)) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(value.text)) return true;
  const declaration = declarationOf(value);
  return (
    !!declaration &&
    ts.isVariableDeclaration(declaration) &&
    !!(declaration.parent.flags & ts.NodeFlags.Const) &&
    !!declaration.initializer &&
    ts.isArrayLiteralExpression(ts.skipParentheses(declaration.initializer))
  );
}

// `items.map((item) => result)`, or Array.from when the collection may not be an array.
export function mapCollection(collection: Expression, parameter: string, result: string): string | undefined {
  const kind = collectionKind(collection);
  if (!kind) return;
  const items = textOf(collection);
  if (result === parameter) return kind === 'array' ? items : `Array.from(${items})`;
  const callback = `(${parameter}) => ${result.startsWith('{') ? `(${result})` : result}`;
  return kind === 'array' ? `${items}.map(${callback})` : `Array.from(${items}, ${callback})`;
}
