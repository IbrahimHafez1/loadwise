'use strict';

const ts = require('typescript');
const { checkGraph } = require('./graph.cjs');

function importBindings(clause) {
  if (clause.isTypeOnly) return [];
  const bindings = clause.name ? [clause.name.text] : [];
  if (!clause.namedBindings) return bindings;
  if (ts.isNamespaceImport(clause.namedBindings)) bindings.push(clause.namedBindings.name.text);
  else for (const item of clause.namedBindings.elements) if (!item.isTypeOnly) bindings.push(item.name.text);
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

// One reused buffer with a static callback avoids allocating per node. Callers copy the children out
// before visiting anything else.
const childBuffer = [];
let childCount = 0;
function bufferChild(child) {
  childBuffer[childCount++] = child;
}

// Buffers the node's children in forEachChild order and returns how many there are.
function bufferChildren(node) {
  childCount = 0;
  ts.forEachChild(node, bufferChild);
  return childCount;
}

function isTypeThunk(argument) {
  return ts.isArrowFunction(argument) || ts.isFunctionExpression(argument);
}

//  and  both name their type lazily.
// A relation decorator callback and Nest's forwardRef callback both name their type lazily.
function hasLazyTypeDecorator(node) {
  return (ts.getDecorators(node) || []).some(
    (decorator) =>
      ts.isCallExpression(decorator.expression) &&
      decorator.expression.arguments.some(
        (argument) => isTypeThunk(argument) || (ts.isCallExpression(argument) && argument.arguments.some(isTypeThunk)),
      ),
  );
}

const noTypes = [];

// Types TypeScript copies into emitted design:type / design:paramtypes metadata, which runs at load.
// A decorator that receives a type thunk, such as a TypeORM relation callback, makes that metadata redundant.
function metadataTypes(node) {
  switch (node.kind) {
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      break;
    default:
      return noTypes;
  }
  if (ts.isClassDeclaration(node)) {
    if (!ts.getDecorators(node)?.length) return [];
    const constructor = node.members.find(ts.isConstructorDeclaration);
    return constructor
      ? constructor.parameters
          .filter((parameter) => !hasLazyTypeDecorator(parameter))
          .map((parameter) => parameter.type)
      : [];
  }
  const member =
    ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node);
  if (!member || !ts.getDecorators(node)?.length || hasLazyTypeDecorator(node)) return [];
  return ts.isMethodDeclaration(node)
    ? [node.type, ...node.parameters.map((parameter) => parameter.type)]
    : [node.type];
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
  if (ts.isPropertyDeclaration(node)) return child !== node.initializer || ts.hasStaticModifier(node);
  if (ts.isFunctionLike(node)) return ts.isDecorator(child);
  if (ts.isForStatement(node)) return child === node.initializer || child === node.condition;
  if (ts.isConditionalExpression(node)) return child === node.condition;
  return ts.isBinaryExpression(node) && child === node.left;
}

function recordForwardRefImports(array, forwardRefName, targets, { allowed, imports }) {
  for (const entry of array.elements) {
    if (
      !ts.isCallExpression(entry) ||
      !ts.isIdentifier(entry.expression) ||
      entry.expression.text !== forwardRefName ||
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

function isImportsArray(field) {
  return (
    ts.isPropertyAssignment(field) && field.name.text === 'imports' && ts.isArrayLiteralExpression(field.initializer)
  );
}

function nestModuleOptions(decorator, moduleName) {
  const call = decorator.expression;
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== moduleName ||
    call.arguments.length !== 1
  )
    return;
  const [options] = call.arguments;
  if (ts.isObjectLiteralExpression(options)) return options;
}

function nestModuleBindings(source, resolve) {
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
      const runtimeImports = items.filter((item) => !item.isTypeOnly);
      for (const item of runtimeImports) framework.set((item.propertyName || item.name).text, item.name.text);
    } else if (items.length === 1 && !items[0].isTypeOnly) targets.set(items[0].name.text, statement);
  }
  if (!framework.has('Module') || !framework.has('forwardRef')) return;
  return { framework, targets };
}

// A Nest module cycle still loads its modules. Only tag references whose sole use
// is the exact deferred callback registered in a top-level @Module imports array.
function nestForwardReferences(source, resolve) {
  if (!source.text.includes('@nestjs/common') || !source.text.includes('forwardRef')) return;
  const bindings = nestModuleBindings(source, resolve);
  if (!bindings) return;
  const { framework, targets } = bindings;
  const allowed = new Set(),
    imports = new Map();
  for (const declaration of source.statements) {
    if (!ts.isClassDeclaration(declaration)) continue;
    for (const decorator of ts.getDecorators(declaration) || []) {
      const options = nestModuleOptions(decorator, framework.get('Module'));
      if (!options) continue;
      for (const field of options.properties.filter(isImportsArray)) {
        recordForwardRefImports(field.initializer, framework.get('forwardRef'), targets, { allowed, imports });
      }
    }
  }
  if (!imports.size) return;
  // An explicit stack keeps long operator chains off the call stack.
  const pending = [source];
  excludeImportsUsedOutsideForwardRefs(pending, imports, allowed);
  return new Set(imports.values());
}

function excludeImportsUsedOutsideForwardRefs(pending, imports, allowed) {
  while (pending.length && imports.size) {
    const node = pending.pop();
    if (ts.isIdentifier(node) && imports.has(node.text) && !allowed.has(node)) imports.delete(node.text);
    for (let index = bufferChildren(node) - 1; index >= 0; index--) pending.push(childBuffer[index]);
  }
}

function collectReexport(statement, preserveImports, references, used) {
  const clause = statement.exportClause;
  if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
    if (preserveImports || !clause || !ts.isNamedExports(clause) || clause.elements.some((item) => !item.isTypeOnly)) {
      references.push({ literal: statement.moduleSpecifier, kind: 'eager' });
    }
  } else if (clause && ts.isNamedExports(clause)) {
    for (const item of clause.elements) if (!item.isTypeOnly) used.add((item.propertyName || item.name).text);
  }
}

function collectImportDeclarations(sourceFile, preserveImports, { references, candidates, imports, used }) {
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      if (statement.importClause?.isTypeOnly) continue;
      if (preserveImports || !statement.importClause) {
        references.push({ literal: statement.moduleSpecifier, kind: 'eager' });
        continue;
      }
      const bindings = importBindings(statement.importClause);
      for (const binding of bindings) candidates.add(binding);
      imports.push({ literal: statement.moduleSpecifier, bindings });
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
      collectReexport(statement, preserveImports, references, used);
    }
  }
}

function collectLoaderCall(node, deferred, references, requires) {
  const literal = node.arguments[0];
  if (!literal || !ts.isStringLiteralLike(literal)) return;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) references.push({ literal, kind: 'deferred' });
  else if (
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length === 1 &&
    !node.questionDotToken
  )
    requires.push({ literal, kind: deferred ? 'deferred' : 'eager' });
}

function collectEdges(sourceFile, file, resolve, compilerOptions = {}) {
  if (sourceFile.isDeclarationFile) return [];
  const javascript = /\.[cm]?jsx?$/i.test(sourceFile.fileName);
  const preserveImports = javascript || compilerOptions.verbatimModuleSyntax === true;
  const imports = [];
  const used = new Set();
  const uses = [];
  const deferredUsed = new Set();
  const metadataUsed = new Set();
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
  collectImportDeclarations(sourceFile, preserveImports, { references, candidates, imports, used });

  // Parallel arrays that never shrink avoid the cost of repeatedly trimming a popped array.
  const stackNodes = [];
  const stackDeferred = [];
  let stackTop = 0;
  function pushNode(node, deferred) {
    stackNodes[stackTop] = node;
    stackDeferred[stackTop++] = deferred;
  }
  // Handles one node and queues its children with their deferred flags. The explicit stack below keeps
  // long operator chains off the call stack.
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
        uses.push({ node, deferred });
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
    collectDecoratorMetadataUses(compilerOptions, node, metadataUsed);
    if (isClassBase(node)) {
      pushNode(node.expression, deferred);
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
    if (ts.isCallExpression(node)) collectLoaderCall(node, deferred, references, requires);
    if (
      compilerOptions.jsx === ts.JsxEmit.React &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))
    )
      used.add((compilerOptions.jsxFactory || 'React.createElement').split('.')[0]);
    const conditional = !deferred && conditionallyExecuted(node);
    for (let index = bufferChildren(node) - 1; index >= 0; index--) {
      const child = childBuffer[index];
      pushNode(child, deferred || (conditional && !alwaysEvaluatedChild(node, child)));
      // Decorators run when the class is defined, even for members whose bodies run later.
      if (conditional && ts.isParameter(child))
        for (const decorator of ts.getDecorators(child) || []) pushNode(decorator, false);
    }
  }
  if (candidates.size || sourceFile.text.includes('require') || sourceFile.text.includes('import')) {
    pushNode(sourceFile, false);
    while (stackTop > 0) {
      stackTop--;
      visit(stackNodes[stackTop], stackDeferred[stackTop]);
    }
  }
  for (const { node, deferred } of uses) {
    if (!shadowed(node.text, node)) (deferred ? deferredUsed : used).add(node.text);
  }
  // A binding read only inside function bodies (for example a TypeORM entity callback) is not
  // evaluated while the module loads, so it cannot close a load-time cycle.
  for (const item of imports) {
    if (item.bindings.some((binding) => used.has(binding))) references.push({ literal: item.literal, kind: 'eager' });
    else if (item.bindings.some((binding) => deferredUsed.has(binding)))
      references.push({
        literal: item.literal,
        kind: item.bindings.some((binding) => metadataUsed.has(binding)) ? 'eager' : 'deferred',
      });
  }
  for (const item of requires) {
    if (!shadowed('require', item.literal)) references.push(item);
  }
  return resolveEdges(sourceFile, file, resolve, references);
}

function resolveEdges(sourceFile, file, resolve, references) {
  const edges = [];
  const forwardReferences = nestForwardReferences(sourceFile, resolve);
  for (const { literal, kind } of references) {
    const target = resolve(literal.text, sourceFile.fileName, literal);
    if (!target) continue;
    const position = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile));
    const edge = { from: file, to: target, line: position.line + 1, column: position.character + 1, kind };
    // Nest forwardRef cycles stay reported, with their contextual reason, rather than disappearing.
    if (forwardReferences?.has(literal)) {
      edge.nestForwardRef = true;
      edge.kind = 'eager';
    }
    edges.push(edge);
  }
  return edges;
}

function collectDecoratorMetadataUses(compilerOptions, node, metadataUsed) {
  if (compilerOptions.emitDecoratorMetadata) {
    for (const type of metadataTypes(node)) {
      let name = type && ts.isTypeReferenceNode(type) ? type.typeName : undefined;
      while (name && ts.isQualifiedName(name)) name = name.left;
      if (name) metadataUsed.add(name.text);
    }
  }
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

module.exports = { analyzeArchitecture, checkGraph, collectEdges, introducesBinding, bindingScope };
