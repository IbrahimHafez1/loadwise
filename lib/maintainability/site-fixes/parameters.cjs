'use strict';

const { walkNodes } = require('../walk.cjs');
const { ts, flaggedFunction, indentationAt, newlineOf, nameUsed } = require('./helpers.cjs');
const { originalProgram } = require('./isolated-program.cjs');
const { listFiles } = require('../inputs.cjs');
const fs = require('node:fs');
const path = require('node:path');

function suppliedPrefix(fn, calls) {
  const prefix = [];
  const supplied = calls.reduce((minimum, call) => Math.min(minimum, call.arguments.length), fn.parameters.length);
  for (const parameter of fn.parameters.slice(0, supplied)) {
    if (parameter.initializer) break;
    if (!parameter.type || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) return [];
    if (parameter.name.text === '__proto__' || parameter.modifiers?.length) return [];
    prefix.push(parameter);
  }
  // Moving a type that refers to a sibling parameter into that parameter's binding pattern can make it circular.
  return prefix.some((p) => prefix.some((sibling) => nameUsed(p.type, sibling.name.text))) ? [] : prefix;
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

function optionsArgument(call, names, sourceFile, firstIndex) {
  const endIndex = firstIndex + names.length;
  const grouped = call.arguments.slice(firstIndex, endIndex);
  if (grouped.length !== names.length || call.arguments.slice(0, endIndex).some(ts.isSpreadElement)) return;
  const properties = [];
  for (const [index, argument] of grouped.entries()) {
    if (gainsPropertyName(argument)) return;
    const name = names[index];
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
  const object = original.includes('\n')
    ? '{' + newline + inner + properties.join(',' + newline + inner) + ',' + newline + indentation + '}'
    : '{ ' + properties.join(', ') + ' }';
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

const applicationSources = new WeakMap();
function usedOutsideFile(load, filename, name) {
  if (!load.projectRoot) return true;
  if (!applicationSources.has(load)) {
    const manifest = path.join(load.projectRoot, 'package.json');
    if (!fs.existsSync(manifest) || JSON.parse(fs.readFileSync(manifest, 'utf8')).private !== true) return true;
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
  const grouped = javaScript ? suppliedJsParameters(fn, calls) : suppliedPrefix(fn, calls);
  if (grouped.length < 2) return;
  const names = grouped.map((p) => p.name.text);
  const firstIndex = fn.parameters.indexOf(grouped[0]);
  const start = grouped[0].getStart(sourceFile);
  const end = grouped.at(-1).end;
  const original = sourceFile.text.slice(start, end);
  if (/\/\/|\/\*/.test(original)) return;
  let binding = '{ ' + names.join(', ') + ' }';
  if (!javaScript) binding += ': ' + parameterTypes(grouped, original, sourceFile, start);
  const edits = [{ start, end, text: binding }];
  for (const call of calls) {
    const edit = optionsArgument(call, names, sourceFile, firstIndex);
    if (!edit) return;
    edits.push(edit);
  }
  if (ts.isMethodDeclaration(fn) && !ts.isPrivateIdentifier(fn.name))
    return {
      edits,
      requiresReview: true,
      note: 'Names the leading arguments at the known internal calls to this TypeScript-private method. Check runtime hooks, external callers and dynamically constructed method names before applying.',
    };
  return { edits, note: 'Names the grouped arguments of this local helper at every direct call site.' };
}

function parameterTypes(parameters, original, sourceFile, start) {
  const typeMembers = parameters.map((p) =>
    p.questionToken ? p.name.text + ': (' + p.type.getText(sourceFile) + ') | undefined' : p.getText(sourceFile),
  );
  const newline = newlineOf(original);
  const indentation = indentationAt(sourceFile.text, start);
  const inner = indentation + '  ';
  return original.includes('\n')
    ? '{' + newline + inner + typeMembers.join(';' + newline + inner) + ';' + newline + indentation + '}'
    : '{ ' + typeMembers.join('; ') + ' }';
}

module.exports = { 'long-parameter-list': groupLocalParameters };
