import path from 'node:path';
import ts from 'typescript';
import { introducesBinding, bindingScope } from './architecture.js';
import type {
  CompilerOptions,
  ExportSpecifier,
  Expression,
  ImportSpecifier,
  Node,
  SourceFile,
  StringLiteralLike,
} from 'typescript';
import type { LocatedFinding } from './types/module-graph.js';
import type { SpecifierResolver } from './types/module-resolver.js';
import type { DataAccessPolicy } from './types/policy.js';

// oxlint-disable-next-line no-control-regex -- Policy paths must reject ASCII control characters.
const invalidPathCharacters = /[\x00-\x1f*?]/;
const MODULE_NAME = /^(?:node:|#|@(?:[\w-][\w.-]*)?\/)?[\w-][\w.-]*(?:\/[\w-][\w.-]*)*$/;
const MESSAGE =
  'Project policy allows this database module to be imported only from approved paths. Call the reviewed data-access function exported by an approved module instead of importing the driver here.';

function contains(parent: string, file: string): boolean {
  return file === parent || file.startsWith(parent + '/');
}

// toRelative is the project-relative path normalizer shared with the other policy sections.
function isDataAccessSection(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => key === 'modules' || key === 'allowIn')
  );
}

function validateDataAccess(raw: unknown, toRelative: (value: string) => string): DataAccessPolicy {
  if (!isDataAccessSection(raw)) throw new Error('dataAccess accepts modules and allowIn arrays.');
  const section = raw;
  function strings(key: string): string[] {
    const values = section[key];
    if (
      !Object.hasOwn(section, key) ||
      !Array.isArray(values) ||
      !values.length ||
      values.some(
        (value: unknown) =>
          typeof value !== 'string' || !value.trim() || value !== value.trim() || invalidPathCharacters.test(value),
      )
    ) {
      throw new Error('dataAccess.' + key + ' requires nonempty literal names or paths.');
    }
    return [...new Set<string>(values)];
  }
  function withinProject(value: string): string {
    if (value.includes(':')) throw new Error('dataAccess paths must be relative paths inside the project.');
    return toRelative(value);
  }
  const modules = new Set<string>();
  const localPaths: string[] = [];
  for (const name of strings('modules')) {
    if (name.startsWith('./')) localPaths.push(withinProject(name));
    else if (MODULE_NAME.test(name)) modules.add(name);
    else throw new Error('dataAccess.modules requires a package name, module alias or ./project/path.');
  }
  return { modules, localPaths, allowedPaths: strings('allowIn').map(withinProject) };
}

// A restricted package also restricts its subpaths, such as pg/lib/client.
function isRestrictedName(modules: ReadonlySet<string>, name: string): boolean {
  for (let prefix = name; prefix; prefix = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '') {
    if (modules.has(prefix)) return true;
  }
  return false;
}

// Collects every `require` binding scope so a local function named require is not mistaken for
// CommonJS.
function requireShadowScopes(sourceFile: SourceFile): Set<Node | undefined> {
  const scopes = new Set<Node | undefined>();
  const pending: Node[] = [sourceFile];
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (ts.isIdentifier(node) && node.text === 'require' && introducesBinding(node)) scopes.add(bindingScope(node));
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return scopes;
}

function isShadowed(scopes: ReadonlySet<Node | undefined>, node: Node): boolean {
  for (let scope: Node | undefined = node; scope; scope = scope.parent) if (scopes.has(scope)) return true;
  return false;
}

function typeOnlyNamedItems(
  items: readonly (ImportSpecifier | ExportSpecifier)[],
  verbatimModuleSyntax: boolean,
): boolean {
  return Boolean(!verbatimModuleSyntax && items?.length && items.every((item) => item.isTypeOnly));
}

// Returns the module-name literals a runtime import, re-export, dynamic import or require call
// loads.
function runtimeLiterals(sourceFile: SourceFile, verbatimModuleSyntax: boolean): StringLiteralLike[] {
  const literals: (Expression | undefined)[] = [];
  const shadowScopes = sourceFile.text.includes('require') ? requireShadowScopes(sourceFile) : undefined;
  const pending: Node[] = [sourceFile];
  for (let node = pending.pop(); node; node = pending.pop()) {
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
        (!shadowScopes || !isShadowed(shadowScopes, node.expression))
      )
        literals.push(node.arguments[0]);
    }
  }
  return literals.filter(
    (literal): literal is StringLiteralLike => literal !== undefined && ts.isStringLiteralLike(literal),
  );
}

function resolvedLocalTarget(
  literal: StringLiteralLike,
  file: string,
  resolve: SpecifierResolver,
  sourceFile: SourceFile,
): string | undefined {
  const target = resolve(literal.text, sourceFile.fileName, literal);
  if (target) return target;
  if (!/^\.{1,2}(?:\/|$)/.test(literal.text)) return undefined;
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), literal.text));
}

function checkDataAccess(
  sourceFile: SourceFile,
  file: string,
  resolve: SpecifierResolver,
  policy: DataAccessPolicy,
  compilerOptions: CompilerOptions = {},
): LocatedFinding[] {
  if (sourceFile.isDeclarationFile || policy.allowedPaths.some((allowed) => contains(allowed, file))) return [];
  const findings: LocatedFinding[] = [];
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

export { validateDataAccess, checkDataAccess };
