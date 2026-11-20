'use strict';

const path = require('node:path');
const ts = require('typescript');
const { walkNodes } = require('./walk.cjs');

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

function collectModuleUsage(sourceFile, file, resolve) {
  const usage = {
    exports: [],
    imports: [],
    reexports: [],
    dynamicUnresolved: [],
    unresolved: [],
    exportEquals: false,
  };

  function position(node) {
    const place = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: place.line + 1, column: place.character + 1 };
  }
  function target(literal) {
    const resolved = resolve(literal.text, sourceFile.fileName, literal);
    return resolved === file ? undefined : resolved;
  }
  // A bare specifier that did not resolve may name a workspace package whose dependencies are not installed.
  function addImport(literal, names) {
    const resolved = resolve(literal.text, sourceFile.fileName, literal);
    if (resolved === file) return;
    if (resolved) usage.imports.push({ to: resolved, names });
    else if (!/^[./]/.test(literal.text)) usage.unresolved.push({ specifier: literal.text, names });
  }

  function recordStatement(statement) {
    if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals) usage.exportEquals = true;
      else usage.exports.push({ name: 'default', ...position(statement) });
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const to = target(statement.moduleSpecifier);
        if (!to) return;
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
      addImport(statement.moduleSpecifier, names.includes('all') ? 'all' : names);
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteralLike(statement.moduleReference.expression)
    ) {
      addImport(statement.moduleReference.expression, 'all');
    } else {
      for (const { name, node } of declaredExports(statement)) usage.exports.push({ name, ...position(node) });
    }
  }
  for (const statement of sourceFile.statements) recordStatement(statement);

  // Declaration files reference modules from inside `declare module` blocks, by augmentation and by triple-slash path.
  function recordDeclarationReferences(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node))
      recordStatement(node);
    else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) addImport(node.name, 'all');
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

  // Dynamic loads and import types can sit anywhere below the top level.
  walkNodes(sourceFile, (node) => {
    if (sourceFile.isDeclarationFile) recordDeclarationReferences(node);
    if (ts.isCallExpression(node)) {
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
      if (argument && ts.isStringLiteralLike(argument)) addImport(argument, 'all');
      else if (argument) recordDynamicLoad(argument, node);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      const qualifier = node.qualifier && ts.isIdentifier(node.qualifier) ? [node.qualifier.text] : 'all';
      addImport(node.argument.literal, qualifier);
    }
  });
  return usage;
}

module.exports = { collectModuleUsage };
