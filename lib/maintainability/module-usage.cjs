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

// The literal text a dynamic specifier starts with: `./locales/${name}` and './locales/' + name both give './locales/'.
function specifierHead(argument) {
  if (ts.isTemplateExpression(argument)) return argument.head.text;
  if (ts.isBinaryExpression(argument) && argument.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return ts.isStringLiteralLike(argument.left) ? argument.left.text : '';
  return '';
}

const browserWorkerNames = new Set(['Worker', 'SharedWorker']);
const workerBindingNames = new Set([...browserWorkerNames, 'URL']);

function workerModule(node) {
  const constructor = ts.skipOuterExpressions(node.expression);
  if (!ts.isIdentifier(constructor) || !browserWorkerNames.has(constructor.text)) return;
  const firstArgument = node.arguments?.[0];
  const url = firstArgument && ts.skipOuterExpressions(firstArgument);
  if (!url || !ts.isNewExpression(url) || url.arguments?.length !== 2) return;
  const urlConstructor = ts.skipOuterExpressions(url.expression);
  if (!ts.isIdentifier(urlConstructor) || urlConstructor.text !== 'URL') return;
  const [specifier, base] = url.arguments.map(ts.skipOuterExpressions);
  if (!ts.isStringLiteralLike(specifier) || !/^\.\.?\//.test(specifier.text)) return;
  if (
    ts.isPropertyAccessExpression(base) &&
    base.name.text === 'url' &&
    ts.isMetaProperty(base.expression) &&
    base.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    base.expression.name.text === 'meta'
  ) {
    return { constructor, urlConstructor, specifier };
  }
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
  const candidates = privateExportCandidates(sourceFile, file);
  let reflectsModule = false;

  // Declaration files reference modules from inside `declare module` blocks, by augmentation and by triple-slash path.
  function recordDeclarationReferences(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node))
      recordStatement(node);
    else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) addImport(node.name, 'all', true);
  }
  if (sourceFile.isDeclarationFile) {
    for (const reference of sourceFile.referencedFiles) {
      const specifier = /^\.{0,2}\//.test(reference.fileName) ? reference.fileName : './' + reference.fileName;
      const resolved = resolve(specifier, sourceFile.fileName);
      if (resolved && resolved !== file) usage.imports.push({ to: resolved, names: 'all' });
    }
  }

  // A relative head limits the load to one folder; with no head it could reach any file, and an external or aliased
  // head is not a project path.
  function recordDynamicLoad(argument, call) {
    const head = specifierHead(argument);
    if (head && !head.startsWith('.')) return;
    const directory = head ? path.posix.dirname(path.posix.join(path.posix.dirname(file), head + 'x')) : undefined;
    usage.dynamicUnresolved.push({ ...position(call), directory });
  }

  const workers = [];
  function recordWorker(node) {
    const worker = workerModule(node);
    if (worker) return workers.push(worker);
    const nodeWorker = nodeWorkerModule(node);
    // The worker runs the module without reading its exports.
    if (nodeWorker) addImport(nodeWorker.literal, [], false, false, nodeWorker.specifier);
  }
  // Dynamic loads, workers, and import types can sit anywhere below the top level.
  walkNodes(sourceFile, (node) => {
    if (candidates.size) {
      if (!reflectsModule && mayReflectModule(node)) reflectsModule = true;
      if (ts.isIdentifier(node)) inspectPrivateExportUse(candidates, node);
    }
    if (!sourceFile.isDeclarationFile && ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name))
      addImport(node.name, 'all', true);
    if (sourceFile.isDeclarationFile) recordDeclarationReferences(node);
    if (ts.isNewExpression(node)) recordWorker(node);
    else if (ts.isCallExpression(node)) {
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
  if (workers.length) {
    const scopes = workerBindingScopes(sourceFile);
    for (const { constructor, urlConstructor, specifier } of workers) {
      if (isShadowed(constructor, scopes) || isShadowed(urlConstructor, scopes)) continue;
      // The worker runs the module without reading its exports.
      addImport(specifier, []);
    }
  }
  return usage;
}

module.exports = { collectModuleUsage };
