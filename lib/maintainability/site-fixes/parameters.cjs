'use strict';

const { walkNodes } = require('../walk.cjs');
const { ts, flaggedFunction, indentationAt, newlineOf, nameUsed } = require('./helpers.cjs');
const { originalProgram } = require('./isolated-program.cjs');
const { listFiles } = require('../inputs.cjs');
const fs = require('node:fs');
const path = require('node:path');

// Groups every position any caller supplies, so no call is left with an object followed by positional arguments.
function suppliedPrefix(fn, calls) {
  const supplied = calls.reduce((maximum, call) => Math.max(maximum, call.arguments.length), 0);
  const prefix = fn.parameters.slice(0, supplied);
  for (const parameter of prefix) {
    if (!parameter.type && !parameter.initializer) return [];
    if (parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) return [];
    if (parameter.name.text === '__proto__' || parameter.modifiers?.length) return [];
  }
  // Moving a type that refers to a sibling parameter into that parameter's binding pattern can make it circular.
  return prefix.some((p) => p.type && prefix.some((sibling) => nameUsed(p.type, sibling.name.text))) ? [] : prefix;
}

// An optional or defaulted parameter reads a missing property exactly like an explicit `undefined`.
function omittable(parameter) {
  return Boolean(parameter.questionToken || parameter.initializer);
}

function isUndefinedLiteral(argument) {
  return ts.isIdentifier(argument) && argument.text === 'undefined';
}

// Swapping two arguments of a closure whose parameter types are mutually unassignable already fails to compile.
function distinctlyTyped(fn, checker) {
  const types = fn.parameters.map((parameter) => checker.getTypeAtLocation(parameter));
  return types.every((type, index) =>
    types.every(
      (other, otherIndex) =>
        index === otherIndex || (!checker.isTypeAssignableTo(type, other) && !checker.isTypeAssignableTo(other, type)),
    ),
  );
}

// Under exactOptionalPropertyTypes an optional property rejects an explicit `undefined` the parameter accepted.
function exactOptionalTypes(load) {
  if (!load.projectRoot) return true;
  try {
    const config = fs.readFileSync(path.join(load.projectRoot, 'tsconfig.json'), 'utf8');
    return /"exactOptionalPropertyTypes"\s*:\s*true/.test(config);
  } catch {
    return false;
  }
}

function directCalls(block, declaration) {
  const calls = [];
  let escapes = false;
  walkNodes(block, (node) => {
    if (ts.isWithStatement(node) || (ts.isIdentifier(node) && node.text === 'eval')) escapes = true;
    if (!ts.isIdentifier(node) || node.text !== declaration.name.text || node === declaration.name) return;
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) calls.push(node.parent);
    else escapes = true;
  });
  return escapes ? [] : calls;
}

// In a named property, an anonymous function or class is assigned an observable name.
function gainsPropertyName(argument) {
  const value = ts.skipOuterExpressions(argument);
  return ts.isArrowFunction(value) || ((ts.isFunctionExpression(value) || ts.isClassExpression(value)) && !value.name);
}

function optionsArgument(call, parameters, sourceFile, firstIndex, javaScript) {
  const endIndex = firstIndex + parameters.length;
  const grouped = call.arguments.slice(firstIndex, endIndex);
  if (call.arguments.slice(0, endIndex).some(ts.isSpreadElement)) return;
  // A TypeScript call may stop early only before optional or defaulted parameters, which the compiler enforces.
  if (grouped.length !== parameters.length && (javaScript || !grouped.length)) return;
  const properties = [];
  for (const [index, argument] of grouped.entries()) {
    if (gainsPropertyName(argument)) return;
    if (!javaScript && omittable(parameters[index]) && isUndefinedLiteral(argument)) continue;
    const name = parameters[index].name.text;
    properties.push(
      ts.isIdentifier(argument) && argument.text === name ? name : name + ': ' + argument.getText(sourceFile),
    );
  }
  const first = grouped[0].getStart(sourceFile);
  const last = grouped.at(-1).end;
  const original = sourceFile.text.slice(first, last);
  if (/\/\/|\/\*/.test(original)) return;
  const newline = newlineOf(original);
  const indentation = indentationAt(sourceFile.text, first);
  const inner = indentation + '  ';
  let object = properties.length ? '{ ' + properties.join(', ') + ' }' : '{}';
  if (properties.length && original.includes('\n'))
    object = '{' + newline + inner + properties.join(',' + newline + inner) + ',' + newline + indentation + '}';
  return { start: first, end: last, text: object };
}

function arrowCalls(fn) {
  const declaration = fn.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.type || !ts.isIdentifier(declaration.name)) return [];
  const list = declaration.parent;
  if (!(list.flags & ts.NodeFlags.Const) || !ts.isVariableStatement(list.parent)) return [];
  const block = list.parent.parent;
  return ts.isBlock(block) ? directCalls(block, declaration) : [];
}

function hasStrictDirective(block) {
  for (const statement of block.statements ?? []) {
    if (!ts.isPrologueDirective(statement)) break;
    if (statement.expression.getText() === "'use strict'" || statement.expression.getText() === '"use strict"')
      return true;
  }
  return false;
}

function isolatedModule(sourceFile) {
  return ts.isExternalModule(sourceFile) || /\.[cm]js$/i.test(sourceFile.fileName);
}

function strictSource(sourceFile) {
  return ts.isExternalModule(sourceFile) || /\.mjs$/i.test(sourceFile.fileName) || hasStrictDirective(sourceFile);
}

function declarationCalls(fn, sourceFile) {
  if (!fn.name || fn.modifiers?.some((modifier) => modifier.kind !== ts.SyntaxKind.AsyncKeyword)) return [];
  const scope = fn.parent;
  if (scope === sourceFile) {
    if (!isolatedModule(sourceFile)) return [];
  } else if (!ts.isBlock(scope) || !ts.isFunctionLike(scope.parent) || scope.parent.body !== scope) return [];
  return directCalls(scope, fn);
}

// Leave defaults and binding patterns in place. Only group positions that every caller actually supplies.
function suppliedJsParameters(fn, calls) {
  const supplied = calls.reduce((minimum, call) => Math.min(minimum, call.arguments.length), fn.parameters.length);
  let longest = [];
  let current = [];
  for (const [index, parameter] of fn.parameters.slice(0, supplied).entries()) {
    if (calls.some((call) => ts.isSpreadElement(call.arguments[index]))) break;
    if (
      parameter.initializer ||
      parameter.dotDotDotToken ||
      !ts.isIdentifier(parameter.name) ||
      parameter.name.text === '__proto__' ||
      calls.some((call) => gainsPropertyName(call.arguments[index]))
    ) {
      current = [];
      continue;
    }
    current.push(parameter);
    if (current.length > longest.length) longest = current;
  }
  return longest;
}

// An unreadable or malformed manifest says nothing about publishing, so the package counts as public.
function privatePackage(manifest) {
  try {
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).private === true;
  } catch {
    return false;
  }
}

const applicationSources = new WeakMap();
function usedOutsideFile(load, filename, name) {
  if (!load.projectRoot) return true;
  if (!applicationSources.has(load)) {
    const manifest = path.join(load.projectRoot, 'package.json');
    if (!privatePackage(manifest)) return true;
    const sources = new Map();
    for (const file of listFiles(load.projectRoot)) {
      if (/\.[cm]?[jt]sx?$/i.test(file)) {
        const absolute = path.resolve(load.projectRoot, file);
        sources.set(absolute, fs.readFileSync(absolute, 'utf8'));
      }
    }
    applicationSources.set(load, sources);
  }
  const currentFile = path.resolve(filename);
  for (const [file, text] of applicationSources.get(load)) {
    if (file !== currentFile && text.includes(name)) return true;
  }
  return false;
}

function methodCalls(fn, sourceFile, load) {
  const runtimePrivate = ts.isPrivateIdentifier(fn.name);
  const modifiers = fn.modifiers ?? [];
  if (!runtimePrivate && !(ts.isIdentifier(fn.name) && modifiers.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)))
    return [];
  if (modifiers.some((m) => ![ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.AsyncKeyword].includes(m.kind))) return [];
  if (fn.parameters.some((p) => p.modifiers?.length) || fn.asteriskToken || nameUsed(fn, 'arguments')) return [];
  if (!runtimePrivate && usedOutsideFile(load, sourceFile.fileName, fn.name.text)) return [];
  const checker = originalProgram(sourceFile).getTypeChecker();
  const method = checker.getSymbolAtLocation(fn.name);
  if (!method || method.declarations?.length !== 1) return [];
  const calls = [];
  let indirect = false;
  walkNodes(runtimePrivate ? fn.parent : sourceFile, (node) => {
    if (ts.isWithStatement(node) || (ts.isIdentifier(node) && node.text === 'eval')) indirect = true;
    if (!runtimePrivate && ts.isElementAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword)
      indirect = true;
    if (node === fn.name || node.text !== fn.name.text) return;
    const access = node.parent;
    if (
      ts.isPropertyAccessExpression(access) &&
      access.name === node &&
      access.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isCallExpression(access.parent) &&
      access.parent.expression === access &&
      checker.getSymbolAtLocation(node) === method
    ) {
      calls.push(access.parent);
    } else indirect = true;
  });
  return indirect ? [] : calls;
}

function callsForHelper(fn, sourceFile, load, javaScript) {
  if (ts.isMethodDeclaration(fn) && ts.isClassDeclaration(fn.parent)) return methodCalls(fn, sourceFile, load);
  if (javaScript && !strictSource(sourceFile)) return [];
  if (ts.isArrowFunction(fn)) return arrowCalls(fn);
  if (javaScript && ts.isFunctionDeclaration(fn) && !nameUsed(fn, 'arguments')) return declarationCalls(fn, sourceFile);
  return [];
}

function documentedSignature(fn) {
  return (
    ts.getJSDocCommentsAndTags(fn).length ||
    fn.parameters.some((parameter) => ts.getJSDocCommentsAndTags(parameter).length)
  );
}

function groupLocalParameters({ node, sourceFile, load }) {
  const fn = flaggedFunction(node);
  if (!fn || fn.typeParameters || (fn.type && ts.isTypePredicateNode(fn.type))) return;
  const javaScript = /\.[cm]?jsx?$/i.test(sourceFile.fileName);
  // A non-simple parameter list makes a function's own "use strict" directive illegal.
  if (hasStrictDirective(fn.body) || (javaScript && documentedSignature(fn))) return;
  if (!javaScript && fn.parameters.some((p) => !ts.isIdentifier(p.name))) return;
  const calls = callsForHelper(fn, sourceFile, load, javaScript);
  if (!calls.length) return;
  const checker = javaScript ? undefined : originalProgram(sourceFile).getTypeChecker();
  if (ts.isArrowFunction(fn) && checker && distinctlyTyped(fn, checker)) return;
  const grouped = javaScript ? suppliedJsParameters(fn, calls) : suppliedPrefix(fn, calls);
  if (grouped.length < 2) return;
  const names = grouped.map((p) =>
    p.initializer ? p.name.text + ' = ' + p.initializer.getText(sourceFile) : p.name.text,
  );
  const firstIndex = fn.parameters.indexOf(grouped[0]);
  const start = grouped[0].getStart(sourceFile);
  const end = grouped.at(-1).end;
  const original = sourceFile.text.slice(start, end);
  if (/\/\/|\/\*/.test(original)) return;
  let binding = '{ ' + names.join(', ') + ' }';
  if (!javaScript) {
    const types = parameterTypes(grouped, { original, sourceFile, start, checker, exact: exactOptionalTypes(load) });
    if (!types) return;
    binding += ': ' + types;
  }
  const edits = [{ start, end, text: binding }];
  for (const call of calls) {
    const edit = optionsArgument(call, grouped, sourceFile, firstIndex, javaScript);
    if (!edit) return;
    edits.push(edit);
  }
  if (ts.isMethodDeclaration(fn) && !ts.isPrivateIdentifier(fn.name))
    return {
      edits,
      requiresReview: true,
      note: 'Names the arguments at the known internal calls to this TypeScript-private method. Check runtime hooks, external callers and dynamically constructed method names before applying.',
    };
  return { edits, note: 'Names the grouped arguments of this local helper at every direct call site.' };
}

// A function, constructor or conditional type needs parentheses before `| undefined`.
function optionalType(typeText, typeNode, exact) {
  if (!exact) return typeText;
  const needsParentheses =
    typeNode &&
    (ts.isFunctionTypeNode(typeNode) || ts.isConstructorTypeNode(typeNode) || ts.isConditionalTypeNode(typeNode));
  return (needsParentheses ? '(' + typeText + ')' : typeText) + ' | undefined';
}

function memberType(parameter, sourceFile, checker) {
  if (parameter.type) return parameter.type.getText(sourceFile);
  const type = checker.getBaseTypeOfLiteralType(checker.getTypeAtLocation(parameter));
  // An unresolved import reads as `any`; writing that out would drop the type the default gave the parameter.
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return;
  return checker.typeToString(type, parameter, ts.TypeFormatFlags.NoTruncation);
}

function parameterTypes(parameters, { original, sourceFile, start, checker, exact }) {
  const typeMembers = [];
  for (const p of parameters) {
    if (!omittable(p)) {
      typeMembers.push(p.getText(sourceFile));
      continue;
    }
    const typeText = memberType(p, sourceFile, checker);
    if (typeText === undefined) return;
    typeMembers.push(p.name.text + '?: ' + optionalType(typeText, p.type, exact));
  }
  const newline = newlineOf(original);
  const indentation = indentationAt(sourceFile.text, start);
  const inner = indentation + '  ';
  return original.includes('\n')
    ? '{' + newline + inner + typeMembers.join(';' + newline + inner) + ';' + newline + indentation + '}'
    : '{ ' + typeMembers.join('; ') + ' }';
}

module.exports = { 'long-parameter-list': groupLocalParameters };
