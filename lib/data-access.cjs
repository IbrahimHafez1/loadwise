'use strict';

const path = require('node:path');

function canonical(filename) {
  const absolute = path.resolve(filename);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function contains(parent, file) {
  return parent === file || file.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

function validateDataAccess(raw, policyPath) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => key !== 'modules' && key !== 'allowIn')
  ) {
    throw new Error('dataAccess accepts modules and allowIn arrays.');
  }
  const root = canonical(path.dirname(policyPath));
  function strings(key) {
    const values = raw[key];
    if (
      !Object.hasOwn(raw, key) ||
      !Array.isArray(values) ||
      !values.length ||
      Array.from(values).some(
        (value) => typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\x00-\x1f*?]/.test(value),
      )
    ) {
      throw new Error('dataAccess.' + key + ' requires nonempty literal names or paths.');
    }
    return [...new Set(values)];
  }
  function withinProject(value) {
    if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes(':')) {
      throw new Error('dataAccess paths must be relative paths inside the policy directory.');
    }
    const target = canonical(path.resolve(root, value.replaceAll('\\', '/')));
    if (!contains(root, target)) throw new Error('dataAccess paths must be inside the policy directory.');
    return target;
  }
  const modules = new Set();
  const localPaths = [];
  for (const name of strings('modules')) {
    if (name.startsWith('./')) localPaths.push(withinProject(name));
    else if (/^(?:node:|#|@(?:[\w-][\w.-]*)?\/)?[\w-][\w.-]*(?:\/[\w-][\w.-]*)*$/.test(name)) modules.add(name);
    else throw new Error('dataAccess.modules requires a package name, module alias or ./project/path.');
  }
  return { modules, localPaths, allowedPaths: strings('allowIn').map(withinProject) };
}

function accessChecker(sourceFile, context, policy) {
  const source = canonical(sourceFile.fileName);
  if (policy.allowedPaths.some((allowed) => contains(allowed, source))) return;
  const ts = require('./compiler.cjs').syntax;
  function examine(literal, requireIdentifier) {
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    const name = literal.text;
    let prefix = name;
    while (prefix && !policy.modules.has(prefix)) {
      const slash = prefix.lastIndexOf('/');
      prefix = slash < 0 ? '' : prefix.slice(0, slash);
    }
    let restricted = Boolean(prefix);
    if (!restricted && policy.localPaths.length) {
      const symbol = context.checker.getSymbolAtLocation(literal);
      // An ambient declaration may describe another module from inside a restricted folder.
      const sourceFiles = symbol?.declarations?.filter(ts.isSourceFile);
      restricted = sourceFiles?.some((file) => {
        const target = canonical(file.fileName);
        return policy.localPaths.some((local) => contains(local, target));
      });
      if (!sourceFiles?.length && /^\.{1,2}(?:\/|$)/.test(name)) {
        const target = canonical(path.resolve(path.dirname(source), name));
        restricted = policy.localPaths.some((local) => contains(local, target));
      }
    }
    if (!restricted) return;
    if (requireIdentifier) {
      const bindings = context.checker.getSymbolAtLocation(requireIdentifier)?.declarations ?? [];
      if (
        !bindings.every(
          (decl) =>
            decl.getSourceFile().isDeclarationFile &&
            /[\\/]node_modules[\\/]@types[\\/]node[\\/]/.test(decl.getSourceFile().fileName),
        )
      )
        return;
    }
    context.report(
      literal,
      'data-access-boundary',
      'Project policy restricts this database import to approved paths. Use the reviewed data-access API from this module.',
    );
  }
  return function checkImport(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (
        clause?.isTypeOnly ||
        (!context.verbatimModuleSyntax &&
          clause &&
          !clause.name &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length &&
          clause.namedBindings.elements.every((item) => item.isTypeOnly))
      )
        return;
      examine(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      const exports = node.exportClause;
      if (
        !context.verbatimModuleSyntax &&
        exports &&
        ts.isNamedExports(exports) &&
        exports.elements.length &&
        exports.elements.every((item) => item.isTypeOnly)
      )
        return;
      examine(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      examine(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) examine(node.arguments[0]);
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length === 1) {
        examine(node.arguments[0], node.expression);
      }
    }
  };
}

module.exports = { validateDataAccess, accessChecker };
