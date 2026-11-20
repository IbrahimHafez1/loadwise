'use strict';

const ts = require('typescript');
const { checkGraph } = require('./graph.cjs');

function importBindings(clause) {
  if (clause.isTypeOnly) return [];
  const bindings = clause.name ? [clause.name.text] : [];
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) bindings.push(clause.namedBindings.name.text);
    else for (const item of clause.namedBindings.elements) if (!item.isTypeOnly) bindings.push(item.name.text);
  }
  return bindings;
}

function isClassBase(node) {
  return (
    ts.isExpressionWithTypeArguments(node) &&
    ts.isHeritageClause(node.parent) &&
    node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
    ts.isClassLike(node.parent.parent)
  );
}

function introducesBinding(node) {
  const parent = node.parent;
  return (
    parent.name === node &&
    (ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent))
  );
}

function bindingScope(name) {
  let declaration = name.parent;
  while (ts.isBindingElement(declaration)) declaration = declaration.parent.parent;
  if (ts.isParameter(declaration)) return declaration.parent;
  if (ts.isFunctionExpression(declaration) || ts.isClassExpression(declaration)) return declaration;
  const variable = ts.isVariableDeclaration(declaration);
  if (variable && ts.isCatchClause(declaration.parent)) return declaration.parent;
  const blockScoped = !variable || declaration.parent.flags & ts.NodeFlags.BlockScoped;
  for (let scope = declaration.parent; scope; scope = scope.parent) {
    if (
      ts.isFunctionLike(scope) ||
      ts.isSourceFile(scope) ||
      (blockScoped &&
        (ts.isBlock(scope) ||
          ts.isCaseBlock(scope) ||
          ts.isForStatement(scope) ||
          ts.isForInStatement(scope) ||
          ts.isForOfStatement(scope)))
    )
      return scope;
  }
}

function conditionallyExecuted(node) {
  if (
    ts.isFunctionLike(node) ||
    ts.isIfStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isTryStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isCallChain(node) ||
    ts.isElementAccessChain(node)
  )
    return true;
  if (!ts.isBinaryExpression(node)) return false;
  const operator = node.operatorToken.kind;
  return (
    operator === ts.SyntaxKind.AmpersandAmpersandToken ||
    operator === ts.SyntaxKind.BarBarToken ||
    operator === ts.SyntaxKind.QuestionQuestionToken ||
    operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    operator === ts.SyntaxKind.BarBarEqualsToken ||
    operator === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

function alwaysEvaluatedChild(node, child) {
  if (
    ts.isIfStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCallChain(node) ||
    ts.isElementAccessChain(node)
  )
    return child === node.expression;
  if (ts.isForStatement(node)) return child === node.initializer || child === node.condition;
  if (ts.isConditionalExpression(node)) return child === node.condition;
  return ts.isBinaryExpression(node) && child === node.left;
}

// A Nest module cycle still loads its modules. Only tag references whose sole use
// is the exact deferred callback registered in a top-level @Module imports array.
function nestForwardReferences(source, resolve) {
  if (!source.text.includes('@nestjs/common') || !source.text.includes('forwardRef')) return;
  const framework = new Map(),
    targets = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (
      !clause ||
      clause.isTypeOnly ||
      clause.name ||
      !clause.namedBindings ||
      !ts.isNamedImports(clause.namedBindings)
    )
      continue;
    const items = clause.namedBindings.elements;
    if (statement.moduleSpecifier.text === '@nestjs/common') {
      if (resolve('@nestjs/common', source.fileName, statement.moduleSpecifier)) return;
      for (const item of items)
        if (!item.isTypeOnly) framework.set((item.propertyName || item.name).text, item.name.text);
    } else if (items.length === 1 && !items[0].isTypeOnly) targets.set(items[0].name.text, statement);
  }
  if (!framework.has('Module') || !framework.has('forwardRef')) return;
  const allowed = new Set(),
    imports = new Map();
  for (const declaration of source.statements) {
    if (!ts.isClassDeclaration(declaration)) continue;
    for (const decorator of ts.getDecorators(declaration) || []) {
      const call = decorator.expression,
        options = call.arguments?.[0];
      if (
        !ts.isCallExpression(call) ||
        !ts.isIdentifier(call.expression) ||
        call.expression.text !== framework.get('Module') ||
        call.arguments.length !== 1 ||
        !ts.isObjectLiteralExpression(options)
      )
        continue;
      for (const field of options.properties) {
        if (
          !ts.isPropertyAssignment(field) ||
          field.name.text !== 'imports' ||
          !ts.isArrayLiteralExpression(field.initializer)
        )
          continue;
        for (const entry of field.initializer.elements) {
          if (
            !ts.isCallExpression(entry) ||
            !ts.isIdentifier(entry.expression) ||
            entry.expression.text !== framework.get('forwardRef') ||
            entry.arguments.length !== 1
          )
            continue;
          const callback = entry.arguments[0];
          if (!ts.isArrowFunction(callback) || callback.parameters.length || !ts.isIdentifier(callback.body)) continue;
          const binding = targets.get(callback.body.text);
          if (binding) {
            allowed.add(binding.importClause.namedBindings.elements[0].name);
            allowed.add(callback.body);
            imports.set(callback.body.text, binding.moduleSpecifier);
          }
        }
      }
    }
  }
  if (!imports.size) return;
  function removeOtherUses(node) {
    if (ts.isIdentifier(node) && imports.has(node.text) && !allowed.has(node)) imports.delete(node.text);
    if (imports.size) ts.forEachChild(node, removeOtherUses);
  }
  removeOtherUses(source);
  return new Set(imports.values());
}

function collectEdges(sourceFile, file, resolve, compilerOptions = {}) {
  if (sourceFile.isDeclarationFile) return [];
  const javascript = /\.[cm]?jsx?$/i.test(sourceFile.fileName);
  const preserveImports = javascript || compilerOptions.verbatimModuleSyntax === true;
  const imports = [];
  const used = new Set();
  const uses = [];
  const candidates = new Set();
  const references = [];
  const requires = [];
  const shadowScopes = new Map();
  function addShadow(name, scope) {
    let scopes = shadowScopes.get(name);
    if (!scopes) shadowScopes.set(name, (scopes = new Set()));
    scopes.add(scope);
  }
  function shadowed(name, node) {
    const scopes = shadowScopes.get(name);
    if (scopes) for (let scope = node; scope; scope = scope.parent) if (scopes.has(scope)) return true;
    return false;
  }
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      if (statement.importClause?.isTypeOnly) continue;
      if (preserveImports || !statement.importClause)
        references.push({ literal: statement.moduleSpecifier, kind: 'eager' });
      else {
        const bindings = importBindings(statement.importClause);
        for (const binding of bindings) candidates.add(binding);
        imports.push({ literal: statement.moduleSpecifier, bindings });
      }
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression &&
      ts.isStringLiteralLike(statement.moduleReference.expression)
    ) {
      const literal = statement.moduleReference.expression;
      if (preserveImports || statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        references.push({ literal, kind: 'eager' });
      } else {
        candidates.add(statement.name.text);
        imports.push({ literal, bindings: [statement.name.text] });
      }
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const clause = statement.exportClause;
      if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        if (
          preserveImports ||
          !clause ||
          !ts.isNamedExports(clause) ||
          clause.elements.some((item) => !item.isTypeOnly)
        ) {
          references.push({ literal: statement.moduleSpecifier, kind: 'eager' });
        }
      } else if (clause && ts.isNamedExports(clause)) {
        for (const item of clause.elements) if (!item.isTypeOnly) used.add((item.propertyName || item.name).text);
      }
    }
  }

  function visit(node, deferred) {
    if (ts.isIdentifier(node)) {
      if ((node.text === 'require' || candidates.has(node.text)) && introducesBinding(node)) {
        addShadow(node.text, bindingScope(node));
        return;
      }
      const parent = node.parent;
      if (
        candidates.has(node.text) &&
        ((parent.name !== node && parent.propertyName !== node) || ts.isShorthandPropertyAssignment(parent))
      )
        uses.push(node);
      return;
    }
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      const names = ts.isImportEqualsDeclaration(node)
        ? [node.name]
        : [
            node.importClause?.name,
            node.importClause?.namedBindings?.name,
            ...(node.importClause?.namedBindings?.elements || []).map((item) => item.name),
          ];
      if (names.some((name) => name?.text === 'require')) addShadow('require', sourceFile);
      return;
    }
    if (ts.isExportDeclaration(node)) return;
    if (isClassBase(node)) {
      visit(node.expression, deferred);
      return;
    }
    if (
      ts.isTypeNode(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
    )
      return;
    if (ts.isCallExpression(node)) {
      const literal = node.arguments[0];
      if (literal && ts.isStringLiteralLike(literal)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) references.push({ literal, kind: 'deferred' });
        else if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'require' &&
          node.arguments.length === 1 &&
          !node.questionDotToken
        )
          requires.push({ literal, kind: deferred ? 'deferred' : 'eager' });
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      if (compilerOptions.jsx === ts.JsxEmit.React)
        used.add((compilerOptions.jsxFactory || 'React.createElement').split('.')[0]);
    }
    const conditional = !deferred && conditionallyExecuted(node);
    ts.forEachChild(node, (child) => visit(child, deferred || (conditional && !alwaysEvaluatedChild(node, child))));
  }
  if (candidates.size || sourceFile.text.includes('require') || sourceFile.text.includes('import'))
    visit(sourceFile, false);
  for (const node of uses) if (!used.has(node.text) && !shadowed(node.text, node)) used.add(node.text);
  for (const item of imports)
    if (item.bindings.some((binding) => used.has(binding))) references.push({ literal: item.literal, kind: 'eager' });
  for (const item of requires) {
    if (!shadowed('require', item.literal)) references.push(item);
  }
  const edges = [];
  const forwardReferences = nestForwardReferences(sourceFile, resolve);
  for (const { literal, kind } of references) {
    const target = resolve(literal.text, sourceFile.fileName, literal);
    if (!target) continue;
    const position = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile));
    const edge = { from: file, to: target, line: position.line + 1, column: position.character + 1, kind };
    if (forwardReferences?.has(literal)) edge.nestForwardRef = true;
    edges.push(edge);
  }
  return edges;
}

function analyzeArchitecture({ files, resolve, boundaries }) {
  const names = [],
    edges = [];
  for (const { sourceFile, file, compilerOptions } of files) {
    names.push(file);
    for (const edge of collectEdges(sourceFile, file, resolve, compilerOptions)) edges.push(edge);
  }
  return checkGraph({ files: names, edges, boundaries });
}

module.exports = { analyzeArchitecture, checkGraph, collectEdges };
