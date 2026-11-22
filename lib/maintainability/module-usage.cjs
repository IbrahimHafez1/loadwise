'use strict';

const path = require('node:path');
const { isBuiltin } = require('node:module');
const ts = require('typescript');
const { introducesBinding, bindingScope } = require('./architecture.cjs');
const { walkNodes } = require('./walk.cjs');
const nodeShebang = /^#![ \t]*(?:\/[^\s]*\/env[ \t]+(?:-S[ \t]+)?node|\/(?:[^/\s]+\/)*node)(?=[ \t\r\n]|$)/;

// What one file exports, and which names of which resolved project files it uses. Plain data, so a worker thread can
// send it back. `names: 'all'` means the whole module is used, as with a namespace import or require().
function hasModifier(node, kind) {
  return Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
}

function declaredExports(statement) {
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
  if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword))
    return [{ name: 'default', node: statement.name ?? statement }];
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations
      .flatMap((declaration) => bindingNames(declaration.name))
      .map((name) => ({ name: name.text, node: name }));
  if (statement.name && ts.isIdentifier(statement.name)) return [{ name: statement.name.text, node: statement.name }];
  return [];
}

function functionSignature(declaration) {
  return [
    ...(declaration.typeParameters ?? []),
    ...declaration.parameters.flatMap((parameter) => (parameter.type ? [parameter.type] : [])),
    ...(declaration.type ? [declaration.type] : []),
  ];
}

function isPrivateMember(member) {
  return hasModifier(member, ts.SyntaxKind.PrivateKeyword) || (member.name && ts.isPrivateIdentifier(member.name));
}

function memberSignature(member) {
  if (isPrivateMember(member)) return [];
  if (ts.isFunctionLike(member)) return functionSignature(member);
  return member.type ? [member.type] : [];
}

// The parts of an exported declaration a consumer sees: its type, its parameter and return types, the public members
// and base classes of a class. A name used there is part of the export's public contract.
function signatureParts(statement) {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return [statement];
  if (ts.isFunctionDeclaration(statement)) return functionSignature(statement);
  if (ts.isClassDeclaration(statement))
    return [
      ...(statement.typeParameters ?? []),
      ...(statement.heritageClauses ?? []),
      ...statement.members.flatMap(memberSignature),
    ];
  if (!ts.isVariableStatement(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration) => {
    const initializer = declaration.initializer && ts.skipOuterExpressions(declaration.initializer);
    const functionParts = initializer && ts.isFunctionLike(initializer) ? functionSignature(initializer) : [];
    return [...(declaration.type ? [declaration.type] : []), ...functionParts];
  });
}

// A type name, `typeof X`, or any reference inside a base-class expression such as `extends createZodDto(Schema)`.
function isContractReference(identifier) {
  const parent = identifier.parent;
  if (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent) || ts.isExpressionWithTypeArguments(parent))
    return true;
  if (ts.isQualifiedName(parent)) return parent.left === identifier;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
  return Boolean(ts.findAncestor(identifier, ts.isHeritageClause));
}

// For each exported declaration, the other exports whose signature names it.
function signatureExposure(statements) {
  const exportNameByLocal = new Map();
  for (const statement of statements) {
    for (const { name, node } of declaredExports(statement))
      if (ts.isIdentifier(node)) exportNameByLocal.set(node.text, name);
  }
  const exposedBy = new Map();
  for (const statement of statements) {
    const [outer] = declaredExports(statement);
    if (!outer) continue;
    for (const part of signatureParts(statement)) {
      walkNodes(part, (node) => {
        const inner = ts.isIdentifier(node) && exportNameByLocal.get(node.text);
        if (!inner || inner === outer.name || !isContractReference(node)) return;
        const owners = exposedBy.get(inner) ?? new Set();
        owners.add(outer.name);
        exposedBy.set(inner, owners);
      });
    }
  }
  return exposedBy;
}

// The initializer of the `const` an identifier names in an enclosing block, so `import(mainPath)` reads like the path it
// was built from. A parameter or another variable of the same name in between shadows it.
function constInitializer(identifier) {
  const named = (name) => bindingNames(name).some((binding) => binding.text === identifier.text);
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some((parameter) => named(parameter.name))) return;
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const declaration = statement.declarationList.declarations.find((item) => named(item.name));
      if (!declaration) continue;
      const constant = statement.declarationList.flags & ts.NodeFlags.Const;
      if (!constant || !ts.isIdentifier(declaration.name) || !declaration.initializer) return;
      return ts.skipOuterExpressions(declaration.initializer);
    }
  }
}

function resolvedPath(argument) {
  return (ts.isIdentifier(argument) && constInitializer(argument)) || argument;
}

function isTemporaryDirectoryCall(expression) {
  if (!ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  return ts.isIdentifier(name) && name.text === 'tmpdir';
}

// `${os.tmpdir()}/x.mjs` and path.join(os.tmpdir(), 'x.mjs') name a file the process wrote outside the project.
function startsInTemporaryDirectory(argument) {
  if (ts.isTemplateExpression(argument)) {
    const [firstSpan] = argument.templateSpans;
    return !argument.head.text && isTemporaryDirectoryCall(ts.skipOuterExpressions(firstSpan.expression));
  }
  if (!ts.isCallExpression(argument) || !ts.isPropertyAccessExpression(argument.expression)) return false;
  const [base] = argument.arguments;
  return ['join', 'resolve'].includes(argument.expression.name.text) && Boolean(base) && isTemporaryDirectoryCall(base);
}

// The literal text a dynamic specifier starts with: `./locales/${name}` and './locales/' + name both give './locales/'.
function specifierHead(argument) {
  if (ts.isTemplateExpression(argument)) return argument.head.text;
  if (ts.isBinaryExpression(argument) && argument.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return ts.isStringLiteralLike(argument.left) ? argument.left.text : '';
  return '';
}

const workerBindingNames = new Set(['URL']);

function isImportMetaUrl(expression) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'url' &&
    ts.isMetaProperty(expression.expression) &&
    expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    expression.expression.name.text === 'meta'
  );
}

// A relative literal, or a const or conditional choosing between relative literals.
function relativeLiterals(expression, followConstant = true) {
  const target = followConstant ? resolvedPath(expression) : expression;
  if (ts.isStringLiteralLike(target)) return /^\.\.?\//.test(target.text) ? [target] : undefined;
  if (!ts.isConditionalExpression(target)) return;
  const whenTrue = relativeLiterals(ts.skipOuterExpressions(target.whenTrue), false);
  const whenFalse = relativeLiterals(ts.skipOuterExpressions(target.whenFalse), false);
  return whenTrue && whenFalse && [...whenTrue, ...whenFalse];
}

// `new URL('./job.mjs', import.meta.url)` names a module file beside this one, whether a Worker, tsImport or a loader
// receives it.
function urlModule(node) {
  const urlConstructor = ts.skipOuterExpressions(node.expression);
  if (!ts.isIdentifier(urlConstructor) || urlConstructor.text !== 'URL' || node.arguments?.length !== 2) return;
  const [specifier, base] = node.arguments.map(ts.skipOuterExpressions);
  const literals = isImportMetaUrl(base) && relativeLiterals(specifier);
  if (literals) return { urlConstructor, literals };
}

const metaUrlLoaders = new Set(['tsImport', 'register']);

// tsx's `tsImport('./x.ts', import.meta.url)` and node:module's `register('./hooks.mjs', import.meta.url)` load a module.
function metaUrlLoad(node) {
  const callee = node.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  if (!ts.isIdentifier(name) || !metaUrlLoaders.has(name.text) || node.arguments.length < 2) return;
  const [specifier, base] = node.arguments.map(ts.skipOuterExpressions);
  if (ts.isStringLiteralLike(specifier) && /^\.\.?\//.test(specifier.text) && isImportMetaUrl(base)) return specifier;
}

// The literal segments of `path.join(__dirname, 'a', 'b.js')` or `path.resolve(...)`, a path in the current file's folder.
function besideCurrentFile(pathCall) {
  if (!ts.isCallExpression(pathCall) || !ts.isPropertyAccessExpression(pathCall.expression)) return;
  const method = pathCall.expression;
  if (!ts.isIdentifier(method.expression) || !['join', 'resolve'].includes(method.name.text)) return;
  const [base, ...parts] = pathCall.arguments.map(ts.skipOuterExpressions);
  if (!base || !ts.isIdentifier(base) || base.text !== '__dirname' || !parts.length) return;
  if (parts.every(ts.isStringLiteralLike) && !parts.some((part) => path.posix.isAbsolute(part.text))) return parts;
}

// Node's `new Worker(path.join(__dirname, 'job.js'))` names its module relative to the current file's folder.
function nodeWorkerModule(node) {
  const constructor = ts.skipOuterExpressions(node.expression);
  if (!ts.isIdentifier(constructor) || constructor.text !== 'Worker') return;
  const firstArgument = node.arguments?.[0];
  const parts = firstArgument && besideCurrentFile(ts.skipOuterExpressions(firstArgument));
  if (!parts) return;
  const relative = path.posix.join(...parts.map((part) => part.text.replaceAll('\\', '/')));
  return { literal: parts.at(-1), specifier: relative.startsWith('.') ? relative : './' + relative };
}

function workerBindingScopes(sourceFile) {
  const scopes = new Map();
  walkNodes(sourceFile, (node) => {
    if (!ts.isIdentifier(node) || !workerBindingNames.has(node.text) || !introducesBinding(node)) return;
    const bindings = scopes.get(node.text) ?? new Set();
    bindings.add(bindingScope(node));
    scopes.set(node.text, bindings);
  });
  return scopes;
}

function isShadowed(identifier, scopes) {
  const bindings = scopes.get(identifier.text);
  if (!bindings) return false;
  for (let scope = identifier.parent; scope; scope = scope.parent) if (bindings.has(scope)) return true;
  return false;
}

function numericConstant(expression) {
  if (ts.isNumericLiteral(expression)) return true;
  if (ts.isParenthesizedExpression(expression)) return numericConstant(expression.expression);
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AsteriskToken &&
    numericConstant(expression.left) &&
    numericConstant(expression.right)
  );
}

const reflectionNames = new Set(['module', 'exports', 'require', 'eval', 'Function']);
const reflectionText = /\b(?:module|exports|require|eval|Function)\b|\bimport\s*\(/;

function mayReflectModule(node) {
  if (ts.isIdentifier(node)) return reflectionNames.has(node.text);
  if (ts.isStringTextContainingNode(node)) return reflectionText.test(node.text);
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

// Keep at least one module marker after a batch removes several exports from the same file.
function privateExportCandidates(sourceFile, file) {
  const candidates = new Map();
  if (sourceFile.isDeclarationFile || !/\.[cm]?tsx?$/i.test(file)) return candidates;
  const statements = sourceFile.statements;
  const hasOtherMarker = statements.some(
    (item) => ts.isImportDeclaration(item) || ts.isExportDeclaration(item) || ts.isExportAssignment(item),
  );
  const exports = statements.filter((item) => hasModifier(item, ts.SyntaxKind.ExportKeyword));
  const anchor =
    !hasOtherMarker && exports.findLast((item) => !ts.isInterfaceDeclaration(item) && !ts.isTypeAliasDeclaration(item));
  if (!hasOtherMarker && !anchor) return candidates;
  for (const statement of exports) {
    if (statement === anchor || statement.modifiers.length !== 1) continue;
    let name;
    let kind;
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      name = statement.name;
      kind = 'type';
    } else if (ts.isFunctionDeclaration(statement) && statement.body && !statement.asteriskToken) {
      name = statement.name;
      kind = 'function';
    } else if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
      const declarations = statement.declarationList.declarations;
      if (declarations.length !== 1 || !declarations[0].initializer || !numericConstant(declarations[0].initializer))
        continue;
      name = declarations[0].name;
      kind = 'constant';
    }
    if (name && ts.isIdentifier(name)) candidates.set(name.text, { statement, name, kind, locallyUsed: false });
  }
  return candidates;
}

function ownsLines(sourceFile, node) {
  const text = sourceFile.text;
  const start = node.getStart(sourceFile);
  const lineEnd = text.indexOf('\n', node.end);
  return (
    !text.slice(text.lastIndexOf('\n', start - 1) + 1, start).trim() &&
    !text.slice(node.end, lineEnd === -1 ? text.length : lineEnd).trim() &&
    !ts.getLeadingCommentRanges(text, node.pos)?.length
  );
}

// `export type { Name };` forwarding an `import type { Name }` that nothing else in the file uses. Removing both is one
// change over the lines from the import to the re-export, so only imports may sit between them.
function typeReexportRemoval(sourceFile, statement) {
  const clause = statement.exportClause;
  if (statement.moduleSpecifier || !clause || !ts.isNamedExports(clause) || clause.elements.length !== 1) return;
  const [element] = clause.elements;
  if (element.propertyName || !(statement.isTypeOnly || element.isTypeOnly)) return;
  const name = element.name.text;
  const statements = sourceFile.statements;
  const exportIndex = statements.indexOf(statement);
  const importIndex = statements.findIndex((item) => {
    const named = ts.isImportDeclaration(item) && item.importClause?.namedBindings;
    return named && ts.isNamedImports(named) && named.elements.some((binding) => binding.name.text === name);
  });
  const declaration = statements[importIndex];
  const importClause = declaration?.importClause;
  // `import type` is always erased, so removing it cannot change which modules load.
  if (
    importIndex < 0 ||
    importIndex > exportIndex ||
    !importClause.isTypeOnly ||
    importClause.name ||
    importClause.namedBindings.elements.length !== 1 ||
    importClause.namedBindings.elements[0].propertyName ||
    !statements.slice(importIndex + 1, exportIndex).every(ts.isImportDeclaration) ||
    !ownsLines(sourceFile, declaration) ||
    !ownsLines(sourceFile, statement)
  )
    return;
  let usedElsewhere = false;
  const inside = (node, owner) => node.pos >= owner.pos && node.end <= owner.end;
  walkNodes(sourceFile, (node) => {
    if (ts.isIdentifier(node) && node.text === name && !inside(node, declaration) && !inside(node, statement))
      usedElsewhere = true;
  });
  // The file must stay a module once both statements are gone.
  const marker = statements.some(
    (item) =>
      item !== declaration &&
      item !== statement &&
      (ts.isImportDeclaration(item) ||
        ts.isExportDeclaration(item) ||
        ts.isExportAssignment(item) ||
        hasModifier(item, ts.SyntaxKind.ExportKeyword)),
  );
  if (usedElsewhere || !marker) return;
  const lines = sourceFile.text.split(/\r?\n/);
  const rowOf = (offset) => sourceFile.getLineAndCharacterOfPosition(offset).line;
  const first = rowOf(declaration.getStart(sourceFile));
  const exportRow = rowOf(statement.getStart(sourceFile));
  const removed = new Set();
  for (let row = first; row <= rowOf(declaration.end); row++) removed.add(row);
  removed.add(exportRow);
  // Keep one blank line where the re-export sat between two.
  if (!lines[exportRow - 1]?.trim() && !lines[exportRow + 1]?.trim() && exportRow + 1 < lines.length)
    removed.add(exportRow + 1);
  let last = Math.max(...removed);
  // A line change needs at least one remaining line, so include the next one unchanged.
  if (last + 1 < lines.length) last++;
  const span = lines.slice(first, last + 1);
  const kept = span.filter((_line, index) => !removed.has(first + index));
  if (!kept.length) return;
  return { name, change: { line: first + 1, before: span.join('\n'), after: kept.join('\n') } };
}

// An inferred public return type can expose even a type used in a local variable (TS4053).
// An explicit return annotation bounds what escapes the function. Parameters are part of
// the signature itself, so accept them only on a private method with that same bound.
function privateTypeUse(identifier) {
  if (!ts.isTypeReferenceNode(identifier.parent) || identifier.parent.typeName !== identifier) return false;
  for (let node = identifier.parent; node.parent; node = node.parent) {
    const fn = node.parent;
    if (!ts.isFunctionLike(fn)) continue;
    if (!fn.type) continue;
    if (fn.body === node) return true;
    if (ts.isMethodDeclaration(fn) && hasModifier(fn, ts.SyntaxKind.PrivateKeyword) && fn.parameters.includes(node))
      return true;
  }
  return false;
}

function inspectPrivateExportUse(candidates, identifier) {
  const candidate = candidates.get(identifier.text);
  if (!candidate || identifier === candidate.name) return;
  const parent = identifier.parent;
  let eligible;
  if (candidate.kind === 'type') {
    eligible = ts.isTypeReferenceNode(parent) && parent.typeName === identifier;
    if (eligible && !privateTypeUse(identifier)) candidate.needsCompiler = true;
  } else if (candidate.kind === 'function') eligible = ts.isCallExpression(parent) && parent.expression === identifier;
  else
    eligible =
      ts.isTemplateSpan(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === identifier) ||
      (ts.isBinaryExpression(parent) && parent.operatorToken.kind < ts.SyntaxKind.FirstAssignment);
  if (!eligible) candidates.delete(identifier.text);
  else if (identifier.pos < candidate.statement.pos || identifier.pos >= candidate.statement.end)
    candidate.locallyUsed = true;
}

// A documented path alone is not evidence that a module is run directly.
// An immediate top-level invocation with its own process failure handler also signals a CLI.
function hasTopLevelCliFailureHandler(statement) {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const { expression, arguments: args } = statement.expression;
  if (
    !ts.isPropertyAccessExpression(expression) ||
    expression.name.text !== 'catch' ||
    !ts.isCallExpression(expression.expression)
  )
    return false;
  const [handler] = args;
  if (!handler || !(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) || !ts.isBlock(handler.body))
    return false;
  return handler.body.statements.some((step) => {
    if (!ts.isExpressionStatement(step) || !ts.isBinaryExpression(step.expression)) return false;
    const { left, right, operatorToken } = step.expression;
    return (
      operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isNumericLiteral(right) &&
      Number(right.text) > 0 &&
      ts.isPropertyAccessExpression(left) &&
      left.name.text === 'exitCode' &&
      ts.isIdentifier(left.expression) &&
      left.expression.text === 'process'
    );
  });
}

// A `/// <reference path>` in a declaration file loads the file it names, like an import of everything it exports.
function addReferencedFileImports(sourceFile, file, resolve, usage) {
  for (const reference of sourceFile.referencedFiles) {
    const specifier = /^\.{0,2}\//.test(reference.fileName) ? reference.fileName : './' + reference.fileName;
    const resolved = resolve(specifier, sourceFile.fileName);
    if (resolved && resolved !== file) usage.imports.push({ to: resolved, names: 'all' });
  }
}

function collectModuleUsage(sourceFile, file, resolve) {
  const usage = {
    executable: nodeShebang.test(sourceFile.text),
    reportsCliFailure: sourceFile.statements.some(hasTopLevelCliFailureHandler),
    exports: [],
    imports: [],
    reexports: [],
    dynamicUnresolved: [],
    unresolved: [],
    uncertainTypeImports: [],
    uncertainRuntimeImports: [],
    exportEquals: false,
  };

  function position(node) {
    const place = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: place.line + 1, column: place.character + 1 };
  }
  function resolveUsage(literal, typeNames, runtimeLoad, specifier = literal.text) {
    let external = isBuiltin(specifier);
    const resolved = resolve(specifier, sourceFile.fileName, literal, () => {
      external = true;
    });
    if (!resolved && !external && typeNames) usage.uncertainTypeImports.push({ specifier, names: typeNames });
    if (!resolved && !external && runtimeLoad && !/\.json$/i.test(specifier))
      usage.uncertainRuntimeImports.push(specifier);
    return resolved;
  }
  // A bare specifier that did not resolve may name a workspace package whose dependencies are not installed.
  function addImport(literal, names, importsTypes = false, runtimeLoad = false, specifier = literal.text) {
    const resolved = resolveUsage(literal, importsTypes && names, runtimeLoad, specifier);
    if (resolved === file) return;
    if (resolved) usage.imports.push({ to: resolved, names });
    else if (!/^[./]/.test(specifier)) usage.unresolved.push({ specifier, names });
  }

  function recordStatement(statement) {
    if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals) usage.exportEquals = true;
      else usage.exports.push({ name: 'default', ...position(statement) });
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const names =
          clause && ts.isNamedExports(clause)
            ? clause.elements.map((item) => (item.propertyName ?? item.name).text)
            : 'all';
        const to = resolveUsage(statement.moduleSpecifier, names);
        if (!to || to === file) return;
        if (!clause) usage.reexports.push({ to, star: true });
        else if (ts.isNamespaceExport(clause)) usage.reexports.push({ to, namespace: clause.name.text });
        else
          usage.reexports.push({
            to,
            pairs: clause.elements.map((item) => ({
              exported: item.name.text,
              local: (item.propertyName ?? item.name).text,
            })),
          });
      } else if (clause && ts.isNamedExports(clause)) {
        for (const item of clause.elements) usage.exports.push({ name: item.name.text, ...position(item.name) });
      }
    } else if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const names = [];
      if (clause?.name) names.push('default');
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push('all');
      else for (const item of clause?.namedBindings?.elements ?? []) names.push((item.propertyName ?? item.name).text);
      addImport(statement.moduleSpecifier, names.includes('all') ? 'all' : names, true);
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteralLike(statement.moduleReference.expression)
    ) {
      addImport(statement.moduleReference.expression, 'all', true);
    } else {
      for (const { name, node } of declaredExports(statement)) usage.exports.push({ name, ...position(node) });
    }
  }
  for (const statement of sourceFile.statements) recordStatement(statement);
  for (const [name, owners] of signatureExposure(sourceFile.statements)) {
    for (const exported of usage.exports) if (exported.name === name) exported.exposedBy = [...owners];
  }
  const declarationByLocal = new Map();
  for (const statement of sourceFile.statements) {
    for (const { name, node } of declaredExports(statement))
      if (ts.isIdentifier(node)) declarationByLocal.set(node.text, { name, statement });
  }
  const usedInModule = new Set();
  // A reference outside the exporting statement, other than a property name, means the module itself needs the binding.
  function recordModuleUse(identifier) {
    const declaration = declarationByLocal.get(identifier.text);
    if (!declaration || (identifier.pos >= declaration.statement.pos && identifier.end <= declaration.statement.end))
      return;
    const parent = identifier.parent;
    if (parent.name === identifier && !ts.isShorthandPropertyAssignment(parent)) return;
    if (ts.isExportSpecifier(parent)) return;
    usedInModule.add(declaration.name);
  }
  const candidates = privateExportCandidates(sourceFile, file);
  let reflectsModule = false;

  // Declaration files reference modules from inside `declare module` blocks, by augmentation and by triple-slash path.
  function recordDeclarationReferences(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      // The statement loop above already recorded the top-level ones.
      if (node.parent !== sourceFile) recordStatement(node);
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) addImport(node.name, 'all', true);
  }
  if (sourceFile.isDeclarationFile) addReferencedFileImports(sourceFile, file, resolve, usage);

  // A relative head limits the load to one folder; with no head it could reach any file, and an external or aliased
  // head is not a project path.
  function recordDynamicLoad(argument, call) {
    const target = resolvedPath(argument);
    if (ts.isStringLiteralLike(target)) return addImport(target, 'all', false, true);
    if (startsInTemporaryDirectory(target)) return;
    const head = specifierHead(target);
    if (head && !head.startsWith('.')) return;
    const directory = head ? path.posix.dirname(path.posix.join(path.posix.dirname(file), head + 'x')) : undefined;
    usage.dynamicUnresolved.push({ ...position(call), directory });
  }

  const urls = [];
  function recordWorker(node) {
    const url = urlModule(node);
    if (url) return urls.push(url);
    const nodeWorker = nodeWorkerModule(node);
    // The worker runs the module without reading its exports.
    if (nodeWorker) addImport(nodeWorker.literal, [], false, false, nodeWorker.specifier);
  }
  // Dynamic loads, workers, and import types can sit anywhere below the top level.
  walkNodes(sourceFile, (node) => {
    if (ts.isIdentifier(node) && declarationByLocal.size) recordModuleUse(node);
    if (candidates.size) {
      if (!reflectsModule && mayReflectModule(node)) reflectsModule = true;
      if (ts.isIdentifier(node)) inspectPrivateExportUse(candidates, node);
    }
    if (!sourceFile.isDeclarationFile && ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name))
      addImport(node.name, 'all', true);
    if (sourceFile.isDeclarationFile) recordDeclarationReferences(node);
    if (ts.isNewExpression(node)) recordWorker(node);
    else if (ts.isCallExpression(node)) {
      const loaded = metaUrlLoad(node);
      if (loaded) return addImport(loaded, 'all', false, true);
      const callee = node.expression;
      const loader =
        callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require');
      const resolver =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'require' &&
        callee.name.text === 'resolve';
      if (!loader && !resolver) return;
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteralLike(argument)) addImport(argument, 'all', false, true);
      else if (argument) recordDynamicLoad(argument, node);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      const qualifier = node.qualifier && ts.isIdentifier(node.qualifier) ? [node.qualifier.text] : 'all';
      addImport(node.argument.literal, qualifier, true);
    }
  });
  for (const exported of usage.exports) if (usedInModule.has(exported.name)) exported.usedInModule = true;
  for (const [name, { statement, locallyUsed, kind, needsCompiler }] of candidates) {
    if (!locallyUsed || (reflectsModule && kind !== 'type')) continue;
    const start = statement.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);
    if (sourceFile.text.slice(lineStart, start).trim()) continue;
    const nextLine = sourceFile.getLineStarts()[line + 1] ?? sourceFile.text.length;
    const before = sourceFile.text.slice(lineStart, nextLine).replace(/[\r\n]+$/, '');
    if (!/^\s*export (?:type|interface|const|function)\s/.test(before)) continue;
    const exported = usage.exports.find((item) => item.name === name);
    exported.runtime = kind !== 'type';
    if (needsCompiler) exported.needsCompiler = true;
    exported.makePrivate = { file, line: line + 1, before, after: before.replace(/^(\s*)export /, '$1') };
  }
  for (const statement of sourceFile.isDeclarationFile ? [] : sourceFile.statements) {
    const removal = ts.isExportDeclaration(statement) && typeReexportRemoval(sourceFile, statement);
    if (!removal) continue;
    const exported = usage.exports.find((item) => item.name === removal.name);
    exported.makePrivate = { file, ...removal.change };
    exported.forwardsImportedType = true;
  }
  if (urls.length) {
    const scopes = workerBindingScopes(sourceFile);
    for (const { urlConstructor, literals } of urls) {
      if (isShadowed(urlConstructor, scopes)) continue;
      // A worker runs the module without reading its exports.
      for (const literal of literals) addImport(literal, []);
    }
  }
  return usage;
}

module.exports = { collectModuleUsage };
