'use strict';

// duplicate-implementation: keeps one top-level function and makes every other copy call it. Applied only when
// each name the copies use resolves to the same binding, so the call runs exactly the code the copy ran.
const { innermostNodeAt } = require('../../shared/fix-hunks.cjs');
const fs = require('node:fs');
const path = require('node:path');
const {
  ts,
  flaggedFunction,
  lineStart,
  lineEnd,
  nextLineStart,
  indentationAt,
  newlineOf,
  nameUsed,
  ownsLines,
  hasMultilineLiteral,
  dedentLines,
} = require('./helpers.cjs');
const { testFile, canonicalKey } = require('../duplicates.cjs');

const {
  stripExtension,
  moduleKey,
  importedBinding,
  bindings,
  checkerFor,
  isolatedHelper,
} = require('./duplicate-bindings.cjs');
const forbiddenKinds = new Set([
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.YieldExpression,
  ts.SyntaxKind.MetaProperty,
]);

function siteAt(load, location) {
  const entry = load(location.file);
  if (!entry?.sourceFile || !(location.line >= 1 && location.line <= entry.lineStarts.length)) return;
  const node = innermostNodeAt(ts, entry.sourceFile, entry.lineStarts[location.line - 1] + location.column - 1);
  const fn = node && flaggedFunction(node);
  if (fn && ts.isBlock(fn.body)) return { file: location.file, entry, sourceFile: entry.sourceFile, fn };
}

// Code that depends on how the function is called, so a plain call from elsewhere would behave differently.
function callSensitive(fn) {
  let found = false;
  (function visit(node) {
    if (found) return;
    if (forbiddenKinds.has(node.kind) || (ts.isIdentifier(node) && node.text === 'arguments')) found = true;
    else ts.forEachChild(node, visit);
  })(fn.body);
  return found || Boolean(fn.asteriskToken);
}

function exported(statement) {
  return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

// A top-level function in a module that is not a test, so importing it runs no test registration.
function canonicalCandidate(site) {
  const { fn, file, sourceFile } = site;
  return (
    ts.isFunctionDeclaration(fn) &&
    fn.name &&
    ts.isSourceFile(fn.parent) &&
    !testFile.test(file) &&
    ts.isExternalModule(sourceFile) &&
    !callSensitive(fn)
  );
}

function simpleParameters(fn) {
  return fn.parameters.every(
    (parameter) => ts.isIdentifier(parameter.name) && !parameter.initializer && parameter.name.text !== 'this',
  );
}

// Local names that an import or a top-level declaration would clash with.
function bindingDeclared(sourceFile, name, except) {
  let declared = false;
  (function visit(node) {
    if (declared || node === except) return;
    const named =
      ts.isVariableDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isImportSpecifier(node) ||
      ts.isImportClause(node) ||
      ts.isNamespaceImport(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isBindingElement(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassExpression(node);
    if (named && node.name && ts.isIdentifier(node.name) && node.name.text === name) declared = true;
    else ts.forEachChild(node, visit);
  })(sourceFile);
  return declared;
}

function moduleImports(sourceFile) {
  return sourceFile.statements.filter(
    (statement) => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier),
  );
}

// The import bindings (default clause, namespace or named element) used only inside `removed`.
function strandedImports(sourceFile, removed) {
  const imports = moduleImports(sourceFile);
  const bound = [];
  for (const declaration of imports) {
    const clause = declaration.importClause;
    if (clause?.name) bound.push({ declaration, binding: clause, name: clause.name.text });
    const named = clause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) bound.push({ declaration, binding: named, name: named.name.text });
    if (named && ts.isNamedImports(named))
      for (const element of named.elements) bound.push({ declaration, binding: element, name: element.name.text });
  }
  return bound.filter(({ name }) => {
    if (!nameUsed(removed, name)) return false;
    let usedElsewhere = false;
    (function visit(node) {
      if (usedElsewhere || node === removed || imports.includes(node)) return;
      if (ts.isIdentifier(node) && node.text === name) usedElsewhere = true;
      else ts.forEachChild(node, visit);
    })(sourceFile);
    return !usedElsewhere;
  });
}

// Imports used only inside `removed` would be left unused, which fails builds with noUnusedLocals.
function strandsImports(sourceFile, removed) {
  return strandedImports(sourceFile, removed).length > 0;
}

// Loading a module with no runtime imports and no top-level calls has no side effects and cannot close a cycle.
// Imports of modules the importing file already loads add nothing, so they are tolerated.
function inertModule(sourceFile, loadedModules = new Set()) {
  return sourceFile.statements.every((statement) => {
    if (ts.isImportDeclaration(statement))
      return (
        Boolean(statement.importClause?.isTypeOnly) ||
        (ts.isStringLiteral(statement.moduleSpecifier) &&
          loadedModules.has(moduleKey(sourceFile.fileName, statement.moduleSpecifier.text)))
      );
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    )
      return true;
    if (ts.isExportDeclaration(statement)) return !statement.moduleSpecifier || statement.isTypeOnly;
    if (!ts.isVariableStatement(statement)) return false;
    let effect = false;
    (function visit(node) {
      if (effect || (ts.isFunctionLike(node) && node !== statement)) return;
      if (
        ts.isCallExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isTaggedTemplateExpression(node) ||
        ts.isAwaitExpression(node)
      )
        effect = true;
      else ts.forEachChild(node, visit);
    })(statement);
    return !effect;
  });
}

function relativeSpecifier(fromFile, toFile, sourceFile) {
  let specifier = path.relative(path.dirname(fromFile), toFile).replaceAll('\\', '/');
  const explicitExtensions = moduleImports(sourceFile).some((declaration) =>
    /^\.{1,2}\/.*\.[cm]?js$/.test(declaration.moduleSpecifier.text),
  );
  specifier = explicitExtensions ? specifier.replace(/\.([cm]?)tsx?$/, '.$1js') : stripExtension(specifier);
  return specifier.startsWith('.') ? specifier : './' + specifier;
}

function quoteOf(sourceFile) {
  const first = moduleImports(sourceFile)[0];
  return first && first.moduleSpecifier.getText(sourceFile).startsWith('"') ? '"' : "'";
}

// The edit that makes `localName` refer to the canonical function in the copy's file, or { local } when it is
// already imported. Undefined when the import cannot be added without changing load order.
function importEdit(copy, canonical, removedDeclaration) {
  const { sourceFile } = copy;
  const text = sourceFile.text;
  const targetKey = stripExtension(path.resolve(canonical.sourceFile.fileName));
  const name = canonical.fn.name.text;
  const existing = moduleImports(sourceFile).find(
    (declaration) =>
      !declaration.importClause?.isTypeOnly &&
      moduleKey(sourceFile.fileName, declaration.moduleSpecifier.text) === targetKey,
  );
  const named = existing?.importClause?.namedBindings;
  const already =
    named && ts.isNamedImports(named)
      ? named.elements.find((element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === name)
      : undefined;
  if (already) return { local: already.name.text };
  const loadedModules = new Set(
    moduleImports(sourceFile)
      .filter((declaration) => !declaration.importClause?.isTypeOnly)
      .map((declaration) => moduleKey(sourceFile.fileName, declaration.moduleSpecifier.text)),
  );
  if (!existing && !inertModule(canonical.sourceFile, loadedModules)) return;
  let local = name;
  if (bindingDeclared(sourceFile, name, removedDeclaration)) {
    local = 'shared' + name[0].toUpperCase() + name.slice(1);
    if (nameUsed(sourceFile, local)) return;
  }
  const specifier = local === name ? name : `${name} as ${local}`;
  if (named && ts.isNamedImports(named) && named.elements.length) {
    const last = named.elements.at(-1);
    const multiline = text.slice(named.getStart(sourceFile), named.end).includes('\n');
    const trailingComma = named.elements.hasTrailingComma;
    if (multiline) {
      const indentation = indentationAt(text, last.getStart(sourceFile));
      const anchor = trailingComma ? text.indexOf(',', last.end) + 1 : last.end;
      return {
        local,
        edit: {
          start: anchor,
          end: anchor,
          text: (trailingComma ? '' : ',') + newlineOf(text) + indentation + specifier + (trailingComma ? ',' : ''),
        },
      };
    }
    return { local, edit: { start: last.end, end: last.end, text: ', ' + specifier } };
  }
  const imports = moduleImports(sourceFile);
  const quote = quoteOf(sourceFile);
  const line = `import { ${specifier} } from ${quote}${relativeSpecifier(sourceFile.fileName, canonical.sourceFile.fileName, sourceFile)}${quote};`;
  if (!imports.length) return { local, edit: { start: 0, end: 0, text: line + newlineOf(text) } };
  const at = lineEnd(text, imports.at(-1).end);
  return { local, edit: { start: at, end: at, text: newlineOf(text) + line } };
}

// Deletes whole lines from `start`, a line start, through the line holding `last`. A line-based fix cannot replace
// lines with nothing, since an empty replacement leaves one blank line, so the edit also spans a neighbouring line
// and keeps its text.
function lineDeletion(text, start, last) {
  const end = lineEnd(text, last);
  if (start > 0) return { start: start - (text[start - 2] === '\r' ? 2 : 1), end, text: '' };
  const next = nextLineStart(text, end);
  if (next >= text.length) return { start: 0, end: text.length, text: '' };
  return { start: 0, end: lineEnd(text, next), text: text.slice(next, lineEnd(text, next)) };
}

// Removes a whole top-level function with its leading comments and one surrounding blank line.
function removal(fn, sourceFile) {
  const text = sourceFile.text;
  const comments = ts.getLeadingCommentRanges(text, fn.pos) ?? [];
  let start = lineStart(text, comments.length ? comments[0].pos : fn.getStart(sourceFile));
  const before = text.slice(lineStart(text, Math.max(0, start - 1)), start);
  if (start > 0 && !before.trim()) start = lineStart(text, start - 1);
  return lineDeletion(text, start, fn.end);
}

// Two edits at one offset apply in no defined order, so an insertion joins the edit that starts where it does.
function withInsertion(edits, insertion) {
  if (edits.some((edit) => edit.start < insertion.start && insertion.start < edit.end)) return;
  const joined = edits.find((edit) => edit.start === insertion.start);
  if (!joined) return [...edits, insertion];
  return edits.map((edit) => (edit === joined ? { ...edit, text: insertion.text + edit.text } : edit));
}

// Replaces the copy's body with a call to the shared function. An async copy returns the shared promise itself.
function delegation(copy, local) {
  const { fn, sourceFile } = copy;
  const text = sourceFile.text;
  const newline = newlineOf(text);
  const indentation = indentationAt(text, fn.getStart(sourceFile));
  const firstStatement = fn.body.statements[0];
  const inner = indentationAt(text, firstStatement.getStart(sourceFile));
  if (!inner.startsWith(indentation) || inner === indentation) return;
  const argumentsText = fn.parameters
    .map((parameter) => (parameter.dotDotDotToken ? '...' : '') + parameter.name.text)
    .join(', ');
  const edits = [
    {
      start: fn.body.getStart(sourceFile),
      end: fn.body.end,
      text: `{${newline}${inner}return ${local}(${argumentsText});${newline}${indentation}}`,
    },
  ];
  const asyncModifier = fn.modifiers?.find((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  if (asyncModifier) {
    const start = asyncModifier.getStart(sourceFile);
    edits.push({ start, end: start + /^async\s+/.exec(text.slice(start))[0].length, text: '' });
  }
  return edits;
}

// Every comment inside a function body, found through the trivia around each token.
function bodyComments(fn, sourceFile) {
  const text = sourceFile.text;
  const comments = new Map();
  // Comments before the opening brace or after the closing one stay outside the replaced range.
  const start = fn.body.getStart(sourceFile);
  const visit = (node) => {
    const ranges = [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ];
    for (const range of ranges)
      if (range.pos > start && range.end < fn.body.end)
        comments.set(range.pos, text.slice(range.pos, range.end).trim());
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  for (const child of fn.body.getChildren(sourceFile)) visit(child);
  return [...comments.values()];
}

// Replacing the copy's body would delete any comment the kept implementation does not repeat.
function losesComments(copy, canonical) {
  const kept = new Set(bodyComments(canonical.fn, canonical.sourceFile));
  return bodyComments(copy.fn, copy.sourceFile).some((comment) => !kept.has(comment));
}

function rewriteCopy(copy, canonical) {
  const { fn, sourceFile } = copy;
  if (fn.asteriskToken || ts.isAccessor(fn) || ts.isConstructorDeclaration(fn) || !simpleParameters(fn)) return;
  if (losesComments(copy, canonical)) return;
  const name = canonical.fn.name.text;
  const sameFile = copy.file === canonical.file;
  const removable =
    !sameFile && ts.isFunctionDeclaration(fn) && ts.isSourceFile(fn.parent) && !exported(fn) && fn.name?.text === name;
  if (strandsImports(sourceFile, removable ? fn : fn.body)) return;
  if (sameFile) {
    if (fn.parameters.some((parameter) => parameter.name.text === name)) return;
    return delegation(copy, name);
  }
  if (!ts.isExternalModule(sourceFile)) return;
  const imported = importEdit(copy, canonical, removable ? fn : undefined);
  if (!imported) return;
  if (fn.parameters.some((parameter) => parameter.name.text === imported.local)) return;
  const edits = removable ? [removal(fn, sourceFile)] : delegation(copy, imported.local);
  return edits && (imported.edit ? withInsertion(edits, imported.edit) : edits);
}

// Keep both exported arrows in place: in CommonJS a consumer can replace either export independently.
function exportedArrow(site) {
  const { fn, sourceFile } = site;
  const variable = fn.parent;
  if (!ts.isArrowFunction(fn) || !ts.isVariableDeclaration(variable) || !ts.isIdentifier(variable.name)) return;
  const list = variable.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const) || list.declarations.length !== 1)
    return;
  const statement = list.parent;
  if (!ts.isVariableStatement(statement) || statement.parent !== sourceFile || !exported(statement) || variable.type)
    return;
  if (
    fn.modifiers?.length ||
    fn.typeParameters ||
    !fn.type ||
    ts.isTypePredicateNode(fn.type) ||
    !simpleParameters(fn) ||
    callSensitive(fn)
  )
    return;
  if (fn.parameters.some((parameter) => !parameter.type || parameter.dotDotDotToken || parameter.questionToken)) return;
  const signature = sourceFile.text
    .slice(fn.getStart(sourceFile), fn.equalsGreaterThanToken.getStart(sourceFile))
    .trimEnd();
  if (!signature.startsWith('(') || /[\r\n]/.test(signature)) return;
  if (sourceFile.text.slice(fn.equalsGreaterThanToken.end, fn.body.getStart(sourceFile)).trim()) return;
  const suffix = sourceFile.text.slice(fn.body.end, statement.end);
  if (suffix !== ';' && suffix !== '') return;
  return { name: variable.name.text, signature, statement };
}

// The camelCase words that every name starts and ends with, joined as one lower camelCase name; '' when none.
function commonWords(names) {
  const split = names.map((name) => name.split(/(?=[A-Z])/));
  const shortest = Math.min(...split.map((words) => words.length));
  const sameAt = (pick) => split.every((words) => words[pick(words)] === split[0][pick(split[0])]);
  let leading = 0;
  while (leading < shortest && sameAt(() => leading)) leading++;
  let trailing = 0;
  while (leading + trailing < shortest && sameAt((words) => words.length - 1 - trailing)) trailing++;
  const words = [...split[0].slice(0, leading), ...split[0].slice(split[0].length - trailing)];
  const joined = words.join('');
  return /^[A-Za-z][A-Za-z0-9]*$/.test(joined) ? joined[0].toLowerCase() + joined.slice(1) : '';
}

function shareExportedArrows(sites) {
  if (sites.length !== 2 || sites[0].file !== sites[1].file || testFile.test(sites[0].file)) return;
  const [first, second] = sites;
  const original = exportedArrow(first);
  const copy = exportedArrow(second);
  if (
    !original ||
    !copy ||
    original.signature !== copy.signature ||
    first.fn.body.getText() !== second.fn.body.getText()
  )
    return;
  const checker = checkerFor(sites);
  const resolved = sites.map((site) => bindings(checker, site.fn));
  if (
    resolved[0].length !== resolved[1].length ||
    resolved[0].some((binding, index) => !binding || binding !== resolved[1][index])
  )
    return;
  // Named for what both exports share, such as getTokenOptions for getAccessTokenOptions and getRefreshTokenOptions.
  const sharedName = commonWords([original.name, copy.name]);
  const helper =
    sharedName && sharedName.split(/(?=[A-Z])/).length > 1 && !nameUsed(first.sourceFile, sharedName)
      ? sharedName
      : original.name + 'Implementation';
  if (
    nameUsed(first.sourceFile, helper) ||
    nameUsed(first.sourceFile, 'eval') ||
    [original.name, copy.name, 'caller', 'callee', 'stack', 'captureStackTrace'].some((name) =>
      nameUsed(first.fn.body, name),
    )
  )
    return;
  const args = first.fn.parameters.map((parameter) => parameter.name.text).join(', ');
  const call = `${helper}(${args})`;
  const newline = newlineOf(first.sourceFile.text);
  const edits = [
    {
      start: first.fn.equalsGreaterThanToken.end,
      end: first.fn.body.getStart(first.sourceFile),
      text: ` ${call};${newline}${newline}function ${helper}${original.signature} `,
    },
    { start: second.fn.body.getStart(second.sourceFile), end: second.fn.body.end, text: call },
  ];
  if (original.statement.end !== first.fn.body.end)
    edits.push({ start: first.fn.body.end, end: original.statement.end, text: '' });
  return {
    edits,
    requiresReview: true,
    note: 'Both exported functions keep their signatures and call a private implementation. Confirm that they should evolve together.',
  };
}

// Resolve one direct, relative type import to distinguish an unknown callback input from an unresolved any.
const configCheckers = new WeakMap();
function configChecker(first, variable, load) {
  if (configCheckers.has(variable)) return configCheckers.get(variable);
  const source = first.sourceFile;
  const files = new Map([[path.resolve(source.fileName), source]]);
  const imports = new Map();
  for (const statement of moduleImports(source)) {
    const bindings = statement.importClause?.namedBindings;
    if (
      !bindings ||
      !ts.isNamedImports(bindings) ||
      !bindings.elements.some((binding) => nameUsed(variable.type, binding.name.text))
    )
      continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const target = path.posix.join(path.posix.dirname(first.file), specifier.replace(/\.js$/, ''));
    if (target.startsWith('../')) continue;
    const imported = load(target + '.ts')?.sourceFile;
    if (imported) {
      files.set(path.resolve(imported.fileName), imported);
      imports.set(specifier, { resolvedFileName: imported.fileName, extension: ts.Extension.Ts });
    }
  }
  const compilerOptions = { strict: true, lib: ['lib.es5.d.ts'], types: [] };
  const native = ts.createCompilerHost(compilerOptions);
  const host = {
    ...native,
    getSourceFile: (name, ...options) =>
      files.get(path.resolve(name)) ??
      (/^lib\.[\w.]+\.d\.ts$/.test(path.basename(name)) ? native.getSourceFile(name, ...options) : undefined),
    resolveModuleNames: (names, from) =>
      names.map((name) => (path.resolve(from) === path.resolve(source.fileName) ? imports.get(name) : undefined)),
  };
  const checker = ts.createProgram([...files.keys()], compilerOptions, host).getTypeChecker();
  configCheckers.set(variable, checker);
  return checker;
}

function shareConfigCallbacks(sites, load) {
  const first = sites[0];
  const { fn, sourceFile } = first;
  if (sites.length < 2 || sites.some((site) => site.file !== first.file) || !ts.isExternalModule(sourceFile)) return;
  const property = fn.parent;
  if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return;
  const array = property.parent.parent;
  if (!ts.isArrayLiteralExpression(array) || !ts.isPropertyAssignment(array.parent)) return;
  const variable = array.parent.parent.parent;
  if (!ts.isVariableDeclaration(variable) || !variable.type || !ts.isIdentifier(variable.name)) return;
  const statement = variable.parent.parent;
  if (
    !ts.isVariableStatement(statement) ||
    statement.parent !== sourceFile ||
    !(variable.parent.flags & ts.NodeFlags.Const) ||
    variable.parent.declarations.length !== 1
  )
    return;
  if (!ts.isObjectLiteralExpression(variable.initializer) || variable.initializer !== array.parent.parent) return;
  if (
    sites.some(
      ({ fn: copy }) =>
        !ts.isArrowFunction(copy) ||
        !ts.isPropertyAssignment(copy.parent) ||
        copy.parent.name.getText() !== property.name.text ||
        copy.parent.parent.parent !== array ||
        copy.getText() !== fn.getText(),
    )
  )
    return;
  if (fn.modifiers?.length || fn.parameters.length !== 1 || fn.typeParameters || fn.type || callSensitive(fn)) return;
  const parameter = fn.parameters[0];
  if (
    !ts.isIdentifier(parameter.name) ||
    parameter.type ||
    parameter.initializer ||
    parameter.questionToken ||
    parameter.dotDotDotToken
  )
    return;
  if (['eval', 'stack', 'caller', 'callee', 'captureStackTrace'].some((word) => nameUsed(fn.body, word))) return;

  // A small offline checker needs only the two interface declarations, not the application's dependency graph.
  const checker = configChecker(first, variable, load);
  for (const { fn: copy } of sites) {
    const contextual = checker.getContextualType(copy);
    const signatures = contextual && checker.getNonNullableType(contextual).getCallSignatures();
    if (
      checker.getTypeAtLocation(copy.parameters[0]).flags !== ts.TypeFlags.Unknown ||
      signatures?.length !== 1 ||
      signatures[0].getReturnType().flags !== ts.TypeFlags.Unknown
    )
      return;
  }
  const helper = configCallbackName(sites, property, variable, sourceFile);
  if (!helper) return;
  const groups = new Map();
  countConfigCallbackOccurrences(array, sourceFile, groups);
  // Each duplicated property gets its own anchor line, so adjacent duplicated properties can be applied together.
  const keys = [...groups].filter(([, count]) => count > 1).map(([key]) => key);
  const slot = keys.indexOf(property.getText(sourceFile));
  if (
    slot < 0 ||
    slot > 1 ||
    keys.some((key) => key !== property.getText(sourceFile) && key.startsWith(property.name.text + ':'))
  )
    return;
  const text = sourceFile.text;
  const newline = newlineOf(text);
  const firstComment = ts.getLeadingCommentRanges(text, statement.pos)?.[0];
  const top = lineStart(text, firstComment?.pos ?? statement.getStart(sourceFile));
  if (text.slice(top, firstComment?.pos ?? statement.getStart(sourceFile)).trim()) return;
  // Both helpers sit together above the declaration: the first after the line above the blank line that precedes it,
  // the second just before it. Without such a blank line the second helper follows the declaration instead.
  const blankRow = top > 0 ? lineStart(text, top - 1) : 0;
  const above =
    blankRow > 0 && !text.slice(blankRow, top).trim() ? blankRow - (text[blankRow - 2] === '\r' ? 2 : 1) : undefined;
  const aboveUsable = above !== undefined && text.slice(lineStart(text, above), above).trim();
  const after = nextLineStart(text, statement.end);
  if (!aboveUsable && slot && text.slice(statement.end, after).trim()) return;
  const original = fn.body.getText(sourceFile);
  // Reindent only simple single-line strings; whitespace inside a template literal can be observable.
  if (original.includes('`') || /\[\r\n]/.test(original)) return;
  const indentation = indentationAt(text, property.getStart(sourceFile));
  const body = original
    .split(/\r?\n/)
    .map((line, index) => (index && line.startsWith(indentation) ? line.slice(indentation.length) : line))
    .join(newline);
  const name = parameter.name.text;
  const helperText = 'function ' + helper + '(' + name + ': unknown) ' + body;
  // The helper takes the callback's one parameter and reads no `this` or `arguments`, so the field can hold it.
  const edits = sites.map(({ fn: copy }) => ({ start: copy.getStart(sourceFile), end: copy.end, text: helper }));
  if (aboveUsable)
    edits.push(
      slot
        ? { start: top, end: top, text: helperText + newline + newline }
        : { start: above, end: above, text: newline + newline + helperText },
    );
  else
    edits.push(
      slot
        ? { start: after, end: after, text: newline + helperText + newline }
        : { start: top, end: top, text: helperText + newline + newline },
    );
  return {
    edits,
    requiresReview: true,
    note: 'Moves the matching callback bodies into a named helper that each field uses. Check that these fields should evolve together.',
  };
}

// Named after the property and what the fields' keys share, such as transformDiscountDate for discountStartDate and
// discountEndDate; otherwise after the configuration variable and the property.
function configCallbackName(sites, property, variable, sourceFile) {
  const keyOf = ({ fn: copy }) => {
    const field = copy.parent.parent.properties.find(
      (member) => ts.isPropertyAssignment(member) && member.name.getText(sourceFile) === 'key',
    );
    return field && ts.isStringLiteral(field.initializer) ? field.initializer.text : undefined;
  };
  const keys = sites.map(keyOf);
  const shared = keys.every(Boolean) ? commonWords(keys) : '';
  const capitalized = (word) => word[0].toUpperCase() + word.slice(1);
  const described = shared && property.name.text + capitalized(shared);
  if (described && !nameUsed(sourceFile, described)) return described;
  const fallback = variable.name.text + capitalized(property.name.text);
  if (!nameUsed(sourceFile, fallback)) return fallback;
}

function countConfigCallbackOccurrences(array, sourceFile, groups) {
  for (const element of array.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    for (const member of element.properties) {
      if (!ts.isPropertyAssignment(member) || !ts.isArrowFunction(member.initializer)) continue;
      const key = member.getText(sourceFile);
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
  }
}

function buildDuplicate({ finding, load }) {
  const sites = [finding, ...(finding.related ?? [])].map((location) => siteAt(load, location));
  if (sites.some((site) => !site)) return;
  if (sites.every((site) => ts.isArrowFunction(site.fn)))
    return shareExportedArrows(sites) ?? shareConfigCallbacks(sites, load);
  if (sites.every((site) => ts.isMethodDeclaration(site.fn))) return shareClassMethods(sites, checkerFor(sites));
  const candidates = sites.filter(canonicalCandidate);
  const canonical = candidates.find((site) => exported(site.fn)) ?? candidates[0];
  if (!canonical) return;
  const checker = checkerFor(sites);
  const resolved = sites.map((site) => bindings(checker, site.fn));
  const canonicalBindings = resolved[sites.indexOf(canonical)];
  const ownFileKey = 'file:' + stripExtension(path.resolve(canonical.sourceFile.fileName)) + '#';
  const editsByFile = new Map();
  const addEdits = (file, edits) => editsByFile.set(file, [...(editsByFile.get(file) ?? []), ...edits]);
  if (!exported(canonical.fn))
    addEdits(canonical.file, [
      {
        start: canonical.fn.getStart(canonical.sourceFile),
        end: canonical.fn.getStart(canonical.sourceFile),
        text: 'export ',
      },
    ]);
  for (const [index, copy] of sites.entries()) {
    if (copy === canonical) continue;
    const sameNames = canonicalBindings.every((binding, position) => {
      const other = resolved[index][position];
      if (!binding || !other) return false;
      if (binding === other) return copy.file === canonical.file || !binding.startsWith('file:');
      // A copy elsewhere may import the canonical file's own top-level name.
      return binding.startsWith(ownFileKey) && other === 'import:' + binding.slice('file:'.length);
    });
    if (!sameNames || resolved[index].length !== canonicalBindings.length) return;
    const edits = rewriteCopy(copy, canonical);
    if (!edits) return shareSiblingHelper(sites, checker);
    addEdits(copy.file, edits);
  }
  const location = `${canonical.file}:${canonical.fn.getSourceFile().getLineAndCharacterOfPosition(canonical.fn.name.getStart(canonical.sourceFile)).line + 1}`;
  return {
    targets: [...editsByFile].map(([file, edits]) => ({ file, edits })),
    note: `Keeps ${location} as the one implementation; the other copies now call it.`,
  };
}

// Importing one decorated class module from the other can introduce a cycle or execute decorators earlier.
// A new, independent module is an alternative for identical private helpers whose only consumers call them.
const maximumSharedHelperLines = 30;

function shareSiblingHelper(sites, checker) {
  const first = sites[0];
  if (!sites.every(canonicalCandidate)) return;
  const helper = first.fn.name.text;
  const implementation = first.fn.getText(first.sourceFile);
  const helperDoc = leadingDoc(first);
  if (
    !/^[a-z][A-Za-z0-9]*$/.test(helper) ||
    implementation.split('\n').length > maximumSharedHelperLines ||
    /@|eslint|prettier/.test(helperDoc)
  )
    return;
  const folder = path.dirname(first.file);
  const stem = kebabCase(helper);
  const file = path.posix.join(folder.replaceAll('\\', '/'), stem + '.ts');
  const targets = [];
  for (const site of sites) {
    const { fn, sourceFile } = site;
    if (
      path.dirname(site.file) !== folder ||
      !site.file.endsWith('.ts') ||
      fn.modifiers?.length ||
      fn.getText(sourceFile) !== implementation ||
      leadingDoc(site) !== helperDoc ||
      !isolatedHelper(site, checker)
    )
      return;
    if (!ownsLines(fn)) return;
    const relativeImports = moduleImports(sourceFile).filter((statement) =>
      statement.moduleSpecifier.text.startsWith('.'),
    );
    if (
      !relativeImports.length ||
      relativeImports.some((statement) => /\.[cm]?tsx?$/.test(statement.moduleSpecifier.text))
    )
      return;
    const specifier = relativeSpecifier(site.file, file, sourceFile);
    const quote = quoteOf(sourceFile);
    // The new import joins the file's own relative imports, after the last of them.
    const importAt = lineEnd(sourceFile.text, relativeImports.at(-1).end);
    const importText = newlineOf(sourceFile.text) + `import { ${helper} } from ${quote}${specifier}${quote};`;
    const edits = withInsertion([removal(fn, sourceFile)], { start: importAt, end: importAt, text: importText });
    if (!edits) return;
    targets.push({ file: site.file, edits });
  }
  // Refuse shadowing by other extensions or a directory of the same name, including on case-insensitive systems.
  const neighbors = fs.readdirSync(path.dirname(first.sourceFile.fileName));
  if (neighbors.some((name) => name.toLowerCase() === stem || name.toLowerCase().startsWith(stem + '.'))) return;
  return {
    targets,
    createdModule: { file, text: helperDoc + 'export ' + implementation + newlineOf(first.sourceFile.text) },
    requiresReview: true,
    note: 'Moves identical module-private helpers into a new sibling module. Verify that this helper should evolve with both consumers and is included by your build.',
  };
}

// The method from its parameters to its closing brace, without the class indentation. Undefined when that would
// change a literal or the lines are not indented under the method.
function methodShape({ fn, sourceFile }) {
  if (hasMultilineLiteral(fn) || /\\\r?\n/.test(fn.getText(sourceFile))) return;
  const text = sourceFile.text.slice(fn.name.end, fn.end).replaceAll('\r\n', '\n');
  const [head, ...rest] = text.split('\n');
  const body = dedentLines(rest.join('\n'), indentationAt(sourceFile.text, fn.getStart(sourceFile)));
  return body === undefined ? undefined : head + '\n' + body;
}

function importDeclarationOf(declaration) {
  if (ts.isImportSpecifier(declaration)) return declaration.parent.parent.parent;
  if (ts.isImportClause(declaration)) return declaration.parent;
  if (ts.isNamespaceImport(declaration)) return declaration.parent.parent;
}

// Each name the method refers to: one of its own declarations, a global, or an import. Undefined when it reads a
// class or module-private name, which a function in another module could not see.
function methodReferences({ fn }, checker) {
  const references = [];
  let movable = true;
  (function visit(node) {
    if (!movable) return;
    const parent = node.parent;
    const skipped =
      node === fn.name ||
      ((ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) && parent.name === node) ||
      (ts.isQualifiedName(parent) && parent.right === node);
    if (ts.isIdentifier(node) && !skipped) {
      const symbol =
        ts.isShorthandPropertyAssignment(parent) && parent.name === node
          ? checker.getShorthandAssignmentValueSymbol(parent)
          : checker.getSymbolAtLocation(node);
      const declaration = symbol?.declarations?.[0];
      const imported = declaration && importDeclarationOf(declaration);
      if (!declaration) references.push({ key: 'global:' + node.text, name: node.text });
      else if (declaration.pos >= fn.pos && declaration.end <= fn.end) references.push({ key: 'local' });
      else if (imported && ts.isStringLiteral(imported.moduleSpecifier)) {
        const source = moduleKey(fn.getSourceFile().fileName, imported.moduleSpecifier.text);
        references.push({ key: `import:${source}#${node.text}`, name: node.text, imported, binding: declaration });
      } else movable = false;
    }
    ts.forEachChild(node, visit);
  })(fn);
  return movable ? references : undefined;
}

// The helper module's copy of each import the method uses, written relative to the new module's folder.
function helperImports(site, references, folder) {
  const used = new Map();
  for (const { imported, binding } of references) {
    if (!imported) continue;
    if (!used.has(imported)) used.set(imported, new Set());
    used.get(imported).add(binding);
  }
  const quote = quoteOf(site.sourceFile);
  return [...used].map(([declaration, bindings]) => {
    let specifier = declaration.moduleSpecifier.text;
    if (specifier.startsWith('.')) {
      const target = path.posix.join(path.posix.dirname(site.file), specifier);
      specifier = path.posix.relative(folder, target);
      if (!specifier.startsWith('.')) specifier = './' + specifier;
    }
    const clause = declaration.importClause;
    const parts = [];
    if (bindings.has(clause)) parts.push(clause.name.text);
    const named = clause.namedBindings;
    if (named && bindings.has(named)) parts.push('* as ' + named.name.text);
    const elements = named && ts.isNamedImports(named) ? named.elements.filter((item) => bindings.has(item)) : [];
    if (elements.length) parts.push(`{ ${elements.map((item) => item.getText(site.sourceFile)).join(', ')} }`);
    return `import ${clause.isTypeOnly ? 'type ' : ''}${parts.join(', ')} from ${quote}${specifier}${quote};`;
  });
}

// Removes imports that only the replaced method body used. Undefined when one cannot be removed on its own lines.
function strandedImportRemovals(sourceFile, body) {
  const text = sourceFile.text;
  const byDeclaration = new Map();
  for (const { declaration, binding } of strandedImports(sourceFile, body)) {
    if (!byDeclaration.has(declaration)) byDeclaration.set(declaration, []);
    byDeclaration.get(declaration).push(binding);
  }
  const edits = [];
  for (const [declaration, bindings] of byDeclaration) {
    const declarationText = declaration.getText(sourceFile);
    if (/\/\/|\/\*/.test(declarationText) || !ownsLines(declaration)) return;
    const clause = declaration.importClause;
    const named = clause.namedBindings;
    const elements = named && ts.isNamedImports(named) ? named.elements : [];
    const total = (clause.name ? 1 : 0) + (named && ts.isNamespaceImport(named) ? 1 : 0) + elements.length;
    if (bindings.length === total) {
      edits.push(lineDeletion(text, lineStart(text, declaration.getStart(sourceFile)), declaration.end));
      continue;
    }
    if (bindings.some((binding) => !ts.isImportSpecifier(binding))) return;
    const kept = elements.filter((element) => !bindings.includes(element));
    if (!declarationText.includes('\n')) {
      const list = `{ ${kept.map((element) => element.getText(sourceFile)).join(', ')} }`;
      edits.push({ start: named.getStart(sourceFile), end: named.end, text: list });
      continue;
    }
    for (const element of bindings) {
      const rest = text.slice(element.end, lineEnd(text, element.end));
      if (!ownsLines(element) && !/^,\s*$/.test(rest)) return;
      edits.push(lineDeletion(text, lineStart(text, element.getStart(sourceFile)), element.end));
    }
  }
  return edits;
}

function commonFolder(files) {
  const [first, ...others] = files.map((file) => path.posix.dirname(file).split('/'));
  let length = first.length;
  for (const segments of others) {
    let shared = 0;
    while (shared < Math.min(length, segments.length) && segments[shared] === first[shared]) shared++;
    length = shared;
  }
  return first.slice(0, length).join('/');
}

// The method as a candidate to share, or undefined when a function in another module could not stand in for it.
function sharedMethodCandidate(site, helper, checker) {
  const { fn } = site;
  if (
    !ts.isClassLike(fn.parent) ||
    !site.file.endsWith('.ts') ||
    testFile.test(site.file) ||
    !ts.isExternalModule(site.sourceFile) ||
    fn.questionToken ||
    fn.asteriskToken ||
    !fn.body.statements.length ||
    !simpleParameters(fn) ||
    callSensitive(fn) ||
    fn.parameters.some((parameter) => parameter.name.text === helper)
  )
    return;
  const shape = methodShape(site);
  const references = methodReferences(site, checker);
  if (shape === undefined || !references) return;
  return { site, shape, references, referenceKeys: JSON.stringify(references.map((reference) => reference.key)) };
}

// The largest set of candidates that agree on text and on what every name refers to; the first set on a tie.
function largestSharedMethodGroup(sites, helper, checker) {
  const groups = new Map();
  for (const site of sites) {
    const candidate = sharedMethodCandidate(site, helper, checker);
    if (!candidate) continue;
    const key = candidate.shape + '\0' + candidate.referenceKeys;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  let largest = [];
  for (const group of groups.values()) if (group.length > largest.length) largest = group;
  return largest.length > 1 ? largest : undefined;
}

const maximumHelperSearchFiles = 400;

// Exported top-level functions in the folders from `folderPath` up to the project root.
function* exportedFunctionsAbove(folderPath, rootPath, excludedFiles) {
  let scanned = 0;
  for (let current = folderPath; current.startsWith(rootPath); current = path.dirname(current)) {
    let names = [];
    try {
      names = fs.readdirSync(current);
    } catch {
      // An unreadable folder offers no candidates.
    }
    for (const name of names) {
      const file = path.join(current, name);
      if (!name.endsWith('.ts') || name.endsWith('.d.ts') || testFile.test(file) || excludedFiles.has(file)) continue;
      if (++scanned > maximumHelperSearchFiles) return;
      const text = fs.readFileSync(file, 'utf8');
      if (!text.includes('export function')) continue;
      const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      for (const statement of sourceFile.statements)
        if (ts.isFunctionDeclaration(statement) && statement.name && statement.body && exported(statement))
          yield { fn: statement, sourceFile };
    }
    if (current === rootPath) return;
  }
}

// The import bindings of a module by local name, each as the module and exported name it stands for.
function importedNamesOf(sourceFile) {
  const importedNames = new Map();
  for (const declaration of moduleImports(sourceFile)) {
    const clause = declaration.importClause;
    const named = clause?.namedBindings;
    const bindingNodes = [clause, named && ts.isNamedImports(named) ? undefined : named].filter(Boolean);
    if (named && ts.isNamedImports(named)) bindingNodes.push(...named.elements);
    for (const node of bindingNodes) if (node.name) importedNames.set(node.name.text, importedBinding(node));
  }
  return importedNames;
}

// Whether every name the method reads means the same thing inside the existing function's module.
function sameReferences(references, existing) {
  const importedNames = importedNamesOf(existing.sourceFile);
  return references.every((reference) => {
    if (reference.key === 'local') return true;
    if (reference.imported) return importedNames.get(reference.name) === importedBinding(reference.binding);
    return !bindingDeclared(existing.sourceFile, reference.name, existing.fn);
  });
}

// A function the project already exports with the method's implementation, such as one an earlier fix created.
function findExistingHelper(group, projectRoot) {
  const { site, references } = group[0];
  const { fn, sourceFile } = site;
  const methodKey = canonicalKey(fn, sourceFile);
  const methodType = fn.type?.getText(sourceFile);
  const groupFiles = new Set(group.map((member) => path.resolve(member.site.sourceFile.fileName)));
  const folderPath = path.dirname(path.resolve(sourceFile.fileName));
  for (const existing of exportedFunctionsAbove(folderPath, projectRoot, groupFiles)) {
    if (
      existing.fn.type?.getText(existing.sourceFile) === methodType &&
      !existing.fn.asteriskToken &&
      !callSensitive(existing.fn) &&
      canonicalKey(existing.fn, existing.sourceFile) === methodKey &&
      sameReferences(references, existing)
    )
      return existing;
  }
}

// A call belongs to the class that declares the method only when no function between them rebinds `this`.
function boundToClass(node, classNode) {
  for (let current = node.parent; current && current !== classNode; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isClassLike(current)) return false;
    if (ts.isObjectLiteralExpression(current)) return false;
    if (ts.isClassElement(current) && current.modifiers?.some(isStaticModifier)) return false;
  }
  return true;
}

function isStaticModifier(modifier) {
  return modifier.kind === ts.SyntaxKind.StaticKeyword;
}

// Edits that point every `this.<name>(args)` call at `local`, for a private method that only forwards its
// parameters and that nothing else can reach. Undefined when any use needs the method to stay.
function inlineCallEdits({ fn, sourceFile }, local) {
  const modifiers = fn.modifiers ?? [];
  if (modifiers.length !== 1 || modifiers[0].kind !== ts.SyntaxKind.PrivateKeyword) return;
  if (ts.getLeadingCommentRanges(sourceFile.text, fn.pos)?.length) return;
  const name = fn.name.text;
  const edits = [];
  let inlinable = true;
  // The method's own body is replaced with it, so only the rest of the file can use the name.
  (function visit(node) {
    if (!inlinable || node === fn) return;
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
      inlinable = node.argumentExpression.text !== name;
    if (ts.isPropertyAccessExpression(node) && node.name.text === name) {
      const call = node.parent;
      inlinable =
        node.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isCallExpression(call) &&
        call.expression === node &&
        !call.questionDotToken &&
        !call.typeArguments &&
        call.arguments.length === fn.parameters.length &&
        !call.arguments.some(ts.isSpreadElement) &&
        boundToClass(call, fn.parent);
      if (inlinable) edits.push({ start: node.getStart(sourceFile), end: node.end, text: local });
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  return inlinable ? edits : undefined;
}

// Everything one file needs once its method is shared: calls go to `local` directly when possible, and the method
// otherwise stays as a delegating wrapper.
function siteEdits(site, local) {
  const { fn, sourceFile } = site;
  const calls = inlineCallEdits(site, local);
  const methodEdits = calls ? [removal(fn, sourceFile), ...calls] : delegation(site, local);
  const imports = strandedImportRemovals(sourceFile, calls ? fn : fn.body);
  if (methodEdits && imports) return [...methodEdits, ...imports];
}

// The name the file uses for the shared function; a prefixed one when the file already declares the plain name.
function localNameFor(sourceFile, helper, fn) {
  if (!bindingDeclared(sourceFile, helper, fn)) return helper;
  const local = 'shared' + helper[0].toUpperCase() + helper.slice(1);
  return nameUsed(sourceFile, local) ? undefined : local;
}

function addExistingImport(site, existing, edits) {
  const imported = importEdit(site, existing, site.fn);
  if (!imported || site.fn.parameters.some((parameter) => parameter.name.text === imported.local)) return;
  return imported.edit ? withInsertion(edits, imported.edit) : edits;
}

function addNewModuleImport(site, file, helper, local, edits) {
  const { sourceFile } = site;
  const text = sourceFile.text;
  const relativeImports = moduleImports(sourceFile).filter((statement) =>
    statement.moduleSpecifier.text.startsWith('.'),
  );
  if (relativeImports.some((statement) => /\.[cm]?tsx?$/.test(statement.moduleSpecifier.text))) return;
  const anchor = relativeImports.at(-1) ?? moduleImports(sourceFile).at(-1);
  if (!anchor) return;
  const quote = quoteOf(sourceFile);
  const specifier = relativeSpecifier(site.file, file, sourceFile);
  const named = local === helper ? helper : `${helper} as ${local}`;
  const at = lineEnd(text, anchor.end);
  return withInsertion(edits, {
    start: at,
    end: at,
    text: newlineOf(text) + `import { ${named} } from ${quote}${specifier}${quote};`,
  });
}

// The module that would hold the shared function, in the nearest folder the files have in common.
function newHelperModule(group, helper) {
  const { references, shape } = group[0];
  const sites = group.map((member) => member.site);
  const [first] = sites;
  const folder = commonFolder(sites.map((site) => site.file));
  const stem = kebabCase(helper);
  if (!folder || folder === '.') return;
  const file = folder + '/' + stem + '.ts';
  const absoluteFolder = path.resolve(
    path.dirname(first.sourceFile.fileName),
    path.posix.relative(path.posix.dirname(first.file), folder),
  );
  const neighbors = fs.readdirSync(absoluteFolder);
  if (neighbors.some((name) => name.toLowerCase() === stem || name.toLowerCase().startsWith(stem + '.'))) return;
  const imports = helperImports(first, references, folder);
  const moduleText = (imports.length ? imports.join('\n') + '\n\n' : '') + 'export function ' + helper + shape + '\n';
  return { file, text: moduleText.replaceAll('\n', newlineOf(first.sourceFile.text)) };
}

// Identical private methods in classes of different files: calls reach one exported function, found in the project
// when it already has one with this implementation and otherwise created in a new module. A method that cannot be
// removed stays and delegates to it. Methods that differ from the largest identical set are left alone.
function shareClassMethods(sites, checker) {
  if (new Set(sites.map((site) => site.file)).size !== sites.length) return;
  const helper = ts.isIdentifier(sites[0].fn.name) ? sites[0].fn.name.text : '';
  if (!/^[a-z][A-Za-z0-9]*$/.test(helper)) return;
  const group = largestSharedMethodGroup(sites, helper, checker);
  // The exported function's own name would shadow an outer name the body reads.
  if (!group || group[0].references.some(({ name }) => name === helper)) return;
  const [{ site: first }] = group;
  const projectRoot = path.resolve(first.sourceFile.fileName, ...first.file.split('/').map(() => '..'));
  const existing = findExistingHelper(group, projectRoot);
  const created = existing ? undefined : newHelperModule(group, helper);
  if (!existing && !created) return;
  const sharedName = existing ? existing.fn.name.text : helper;

  const targets = [];
  for (const { site } of group) {
    const local = localNameFor(site.sourceFile, sharedName, site.fn);
    const edits = local && siteEdits(site, local);
    const withImport =
      edits &&
      (existing
        ? addExistingImport(site, existing, edits)
        : addNewModuleImport(site, created.file, sharedName, local, edits));
    if (!withImport) return;
    targets.push({ file: site.file, edits: withImport });
  }
  return {
    targets,
    ...(created && { createdModule: created }),
    requiresReview: true,
    note: existing
      ? 'Calls the exported function the project already has with this implementation, so no new module is created. Verify that these methods should evolve with it and that removed imports had no needed side effects.'
      : 'Moves identical private methods into a new shared module, and calls go to it. Verify that these methods should evolve together, that removed imports had no needed side effects and that your build includes the new module.',
  };
}

function kebabCase(name) {
  return name.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
}

function leadingDoc({ fn, sourceFile }) {
  const comments = ts.getLeadingCommentRanges(sourceFile.text, fn.pos);
  return comments?.length ? sourceFile.text.slice(comments[0].pos, fn.getStart(sourceFile)) : '';
}

module.exports = { 'duplicate-implementation': buildDuplicate };
