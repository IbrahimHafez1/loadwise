'use strict';

const path = require('node:path');
const ts = require('typescript');
const { introducesBinding, bindingScope } = require('./architecture.cjs');

// oxlint-disable-next-line no-control-regex -- Policy paths must reject ASCII control characters.
const invalidPathCharacters = /[\x00-\x1f*?]/;
const MODULE_NAME = /^(?:node:|#|@(?:[\w-][\w.-]*)?\/)?[\w-][\w.-]*(?:\/[\w-][\w.-]*)*$/;
const MESSAGE =
  'Project policy allows this database module to be imported only from approved paths. Call the reviewed data-access function exported by an approved module instead of importing the driver here.';

function contains(parent, file) {
  return file === parent || file.startsWith(parent + '/');
}

// toRelative is the project-relative path normalizer shared with the other policy sections.
function validateDataAccess(raw, toRelative) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => key !== 'modules' && key !== 'allowIn')
  ) {
    throw new Error('dataAccess accepts modules and allowIn arrays.');
  }
  function strings(key) {
    const values = raw[key];
    if (
      !Object.hasOwn(raw, key) ||
      !Array.isArray(values) ||
      !values.length ||
      values.some(
        (value) =>
          typeof value !== 'string' || !value.trim() || value !== value.trim() || invalidPathCharacters.test(value),
      )
    ) {
      throw new Error('dataAccess.' + key + ' requires nonempty literal names or paths.');
    }
    return [...new Set(values)];
  }
  function withinProject(value) {
    if (value.includes(':')) throw new Error('dataAccess paths must be relative paths inside the project.');
    return toRelative(value);
  }
  const modules = new Set();
  const localPaths = [];
  for (const name of strings('modules')) {
    if (name.startsWith('./')) localPaths.push(withinProject(name));
    else if (MODULE_NAME.test(name)) modules.add(name);
    else throw new Error('dataAccess.modules requires a package name, module alias or ./project/path.');
  }
  return { modules, localPaths, allowedPaths: strings('allowIn').map(withinProject) };
}

// A restricted package also restricts its subpaths, such as pg/lib/client.
function isRestrictedName(modules, name) {
  for (let prefix = name; prefix; prefix = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '') {
    if (modules.has(prefix)) return true;
  }
  return false;
}

// Collects every `require` binding scope so a local function named require is not mistaken for CommonJS.
function requireShadowScopes(sourceFile) {
  const scopes = new Set();
  const pending = [sourceFile];
  while (pending.length) {
    const node = pending.pop();
    if (ts.isIdentifier(node) && node.text === 'require' && introducesBinding(node)) scopes.add(bindingScope(node));
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return scopes;
}

function isShadowed(scopes, node) {
  for (let scope = node; scope; scope = scope.parent) if (scopes.has(scope)) return true;
  return false;
}

function typeOnlyNamedItems(items, verbatimModuleSyntax) {
  return !verbatimModuleSyntax && items?.length && items.every((item) => item.isTypeOnly);
}

// Returns the module-name literals a runtime import, re-export, dynamic import or require call loads.
function runtimeLiterals(sourceFile, verbatimModuleSyntax) {
  const literals = [];
  const shadowScopes = requireShadowScopes(sourceFile);
  const pending = [sourceFile];
  while (pending.length) {
    const node = pending.pop();
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyInlineTypes =
        clause && !clause.name && bindings && ts.isNamedImports(bindings)
          ? typeOnlyNamedItems(bindings.elements, verbatimModuleSyntax)
          : false;
      if (!clause?.isTypeOnly && !onlyInlineTypes) literals.push(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      const clause = node.exportClause;
      const onlyInlineTypes =
        clause && ts.isNamedExports(clause) && typeOnlyNamedItems(clause.elements, verbatimModuleSyntax);
      if (!onlyInlineTypes) literals.push(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      literals.push(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) literals.push(node.arguments[0]);
      else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        node.arguments.length === 1 &&
        !isShadowed(shadowScopes, node.expression)
      )
        literals.push(node.arguments[0]);
    }
  }
  return literals.filter((literal) => literal && ts.isStringLiteralLike(literal));
}

function resolvedLocalTarget(literal, file, resolve, sourceFile) {
  const target = resolve(literal.text, sourceFile.fileName, literal);
  if (target) return target;
  if (!/^\.{1,2}(?:\/|$)/.test(literal.text)) return undefined;
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), literal.text));
}

function checkDataAccess(sourceFile, file, resolve, policy, compilerOptions = {}) {
  if (sourceFile.isDeclarationFile || policy.allowedPaths.some((allowed) => contains(allowed, file))) return [];
  const findings = [];
  for (const literal of runtimeLiterals(sourceFile, compilerOptions.verbatimModuleSyntax === true)) {
    let restricted = isRestrictedName(policy.modules, literal.text);
    if (!restricted && policy.localPaths.length) {
      const target = resolvedLocalTarget(literal, file, resolve, sourceFile);
      restricted = target !== undefined && policy.localPaths.some((local) => contains(local, target));
    }
    if (!restricted) continue;
    const position = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile));
    findings.push({
      file,
      line: position.line + 1,
      column: position.character + 1,
      ruleId: 'data-access-boundary',
      message: MESSAGE,
    });
  }
  return findings.sort((left, right) => left.line - right.line || left.column - right.column);
}

module.exports = { validateDataAccess, checkDataAccess };
