'use strict';

const path = require('node:path');
const { requireReview, ts, calleeCall, indentationAt, nameTaken } = require('./helpers.cjs');
const { loadThenSaveShape, mentions } = require('../typeorm-updates.cjs');

const resultNames = ['result', 'updateResult'];
// update() with a non-unique where would touch every matching row, so only a primary-key lookup is rewritten.
const uniqueKey = 'id';
const affectedNote = '`affected` is not reported by every database driver; confirm yours returns it.';
const splitNote =
  'save() wrote every change in one UPDATE; these are separate statements and no longer atomic, so a failure between them leaves the earlier ones applied. Run them in one transaction if that matters.';

function isSimpleWhere(where) {
  if (!ts.isObjectLiteralExpression(where) || where.getText().includes('\n')) return false;
  const properties = where.properties;
  return (
    properties.some((property) => property.name?.getText() === uniqueKey) &&
    properties.every(
      (property) =>
        ts.isShorthandPropertyAssignment(property) ||
        (ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          !ts.isObjectLiteralExpression(property.initializer) &&
          !ts.isArrayLiteralExpression(property.initializer)),
    )
  );
}

function plannedStatements(shape, whereText) {
  const receiver = `await ${shape.repositoryText}`;
  const calls = shape.steps
    .filter((step) => step.kind !== 'set')
    .map((step) => `${receiver}.${step.kind}(${whereText}, '${step.field}', ${step.value?.getText() ?? '1'})`);
  const sets = shape.steps.filter((step) => step.kind === 'set');
  if (sets.length) {
    const assignments = sets.map((step) => {
      const value = step.value.getText();
      return value === step.field ? value : `${step.field}: ${value}`;
    });
    calls.push(`${receiver}.update(${whereText}, { ${assignments.join(', ')} })`);
  }
  return calls;
}

function hasNewlineOrDuplicate(shape) {
  const fields = shape.steps.map((step) => step.field);
  return new Set(fields).size !== fields.length || shape.steps.some((step) => step.value?.getText().includes('\n'));
}

function freeResultName(shape) {
  let container = shape.saveStatement.parent;
  while (container.parent && !ts.isFunctionLike(container)) container = container.parent;
  return resultNames.find((candidate) => !mentions(container, candidate));
}

const notFoundErrorName = 'EntityNotFoundError';
const isNullName = 'IsNull';

// The entity class of the receiver: `users: Repository<User>`, `@InjectRepository(User) users` or
// `users = dataSource.getRepository(User)`.
function repositoryEntity(repositoryText, sourceFile) {
  const name = repositoryText.split('.').at(-1);
  let entity;
  (function visit(node) {
    const declared = ts.isPropertyDeclaration(node) || ts.isParameter(node) || ts.isVariableDeclaration(node);
    if (declared && node.name.getText() === name) entity ??= declaredEntity(node);
    ts.forEachChild(node, visit);
  })(sourceFile);
  return entity;
}

function declaredEntity(declaration) {
  const { type, initializer } = declaration;
  if (type && ts.isTypeReferenceNode(type) && type.typeName.getText() === 'Repository') {
    const [argument] = type.typeArguments ?? [];
    if (argument && ts.isTypeReferenceNode(argument) && ts.isIdentifier(argument.typeName)) return argument.getText();
  }
  const injected = (ts.canHaveDecorators(declaration) ? ts.getDecorators(declaration) : undefined)?.find(
    (decorator) =>
      ts.isCallExpression(decorator.expression) && decorator.expression.expression.getText() === 'InjectRepository',
  );
  const [injectedClass] = injected?.expression.arguments ?? [];
  if (injectedClass && ts.isIdentifier(injectedClass)) return injectedClass.text;
  const created = initializer && ts.isAwaitExpression(initializer) ? initializer.expression : initializer;
  if (created && ts.isCallExpression(created) && ts.isPropertyAccessExpression(created.expression)) {
    const [entityClass] = created.arguments;
    if (created.expression.name.text === 'getRepository' && entityClass && ts.isIdentifier(entityClass))
      return entityClass.text;
  }
}

// Adds `name` to the `typeorm` import, or nothing when the file cannot import it that way.
function typeormImport(sourceFile, name) {
  const declaration = sourceFile.statements.find(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === 'typeorm' &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      !statement.importClause.isTypeOnly,
  );
  if (!declaration) return;
  const { elements } = declaration.importClause.namedBindings;
  if (elements.some((element) => element.name.text === name && !element.propertyName)) return [];
  if (nameTaken(sourceFile, name) || !elements.length) return;
  return [{ start: elements.at(-1).end, end: elements.at(-1).end, text: `, ${name}` }];
}

// --- Soft delete -----------------------------------------------------------
// find*() skips soft-deleted rows but update() and increment() do not, so an entity with a @DeleteDateColumn (on
// itself or a base class) needs `column: IsNull()` in the where to keep finding the same rows.

const maxClassHops = 6;
const compilerOptionsCache = new Map();

function compilerOptionsFor(fileName) {
  const configPath = ts.findConfigFile(path.dirname(fileName), ts.sys.fileExists);
  if (!configPath) return {};
  if (compilerOptionsCache.has(configPath)) return compilerOptionsCache.get(configPath);
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  // Only the options matter (paths, baseUrl), so the include globs are not expanded.
  const host = { ...ts.sys, readDirectory: () => [] };
  const { options } = ts.parseJsonConfigFileContent(config ?? {}, host, path.dirname(configPath));
  compilerOptionsCache.set(configPath, options);
  return options;
}

function resolvedSource(specifier, fromFile) {
  const resolved = ts.resolveModuleName(specifier, fromFile, compilerOptionsFor(fromFile), ts.sys).resolvedModule;
  const file = resolved?.resolvedFileName;
  if (!file || resolved.isExternalLibraryImport || file.endsWith('.d.ts')) return;
  return file;
}

// The class `className` declared in or re-exported by `fileName`, as { klass, sourceFile }.
function exportedClass(load, fileName, className, hops) {
  const sourceFile = hops > 0 ? load(fileName)?.sourceFile : undefined;
  if (!sourceFile) return;
  const klass = sourceFile.statements.find(
    (statement) => ts.isClassDeclaration(statement) && statement.name?.text === className,
  );
  if (klass) return { klass, sourceFile };
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue;
    const named =
      statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause : undefined;
    const element = named?.elements.find((candidate) => candidate.name.text === className);
    if (statement.exportClause && !element) continue;
    const target = resolvedSource(statement.moduleSpecifier.text, sourceFile.fileName);
    const found =
      target && exportedClass(load, target, (element?.propertyName ?? element?.name)?.text ?? className, hops - 1);
    if (found) return found;
  }
}

// The class a name refers to in `sourceFile`: declared there, or imported by name.
function classNamed(load, sourceFile, className, hops) {
  const local = exportedClass(() => ({ sourceFile }), sourceFile.fileName, className, 1);
  if (local) return local;
  for (const statement of sourceFile.statements) {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const element = bindings.elements.find((candidate) => candidate.name.text === className);
    if (!element) continue;
    const target = resolvedSource(statement.moduleSpecifier.text, sourceFile.fileName);
    return target && exportedClass(load, target, (element.propertyName ?? element.name).text, hops);
  }
}

function decoratorCalled(member, name) {
  return (ts.canHaveDecorators(member) ? (ts.getDecorators(member) ?? []) : []).some((decorator) => {
    const expression = ts.isCallExpression(decorator.expression)
      ? decorator.expression.expression
      : decorator.expression;
    return ts.isIdentifier(expression) && expression.text === name;
  });
}

// The soft-delete property of the entity: its name, null when the entity and its bases have none, or undefined
// when a class in the chain cannot be read.
function softDeleteColumn(load, found, hops = maxClassHops) {
  if (!found || hops <= 0) return;
  const column = found.klass.members.find(
    (member) =>
      ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && decoratorCalled(member, 'DeleteDateColumn'),
  );
  if (column) return column.name.text;
  const base = found.klass.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
  if (!base) return null;
  if (!ts.isIdentifier(base.expression)) return;
  return softDeleteColumn(load, classNamed(load, found.sourceFile, base.expression.text, hops), hops - 1);
}

// The where for update(): the lookup's where, plus `column: IsNull()` when the entity is soft-deletable. Undefined
// when the entity cannot be read or the where already names the column.
function liveRowsWhere(shape, sourceFile, load) {
  const entity = repositoryEntity(shape.repositoryText, sourceFile);
  const column = entity && softDeleteColumn(load, classNamed(load, sourceFile, entity, maxClassHops));
  if (column === null) return { text: shape.where.getText(), edits: [] };
  if (!column || shape.where.properties.some((property) => property.name?.getText() === column)) return;
  const edits = typeormImport(sourceFile, isNullName);
  if (!edits) return;
  const inner = shape.where.getText().slice(1, -1).trim();
  return { text: `{ ${inner}, ${column}: ${isNullName}() }`, edits, column };
}

function loadThenSaveFix({ node, text, sourceFile, load }) {
  const call = calleeCall(node);
  const shape = call && loadThenSaveShape(call);
  if (!shape?.steps.length || !isSimpleWhere(shape.where)) return;
  const orFail = shape.method.endsWith('OrFail');
  if ((orFail && shape.guards.length) || hasNewlineOrDuplicate(shape)) return;
  const whereText = shape.where.getText();
  const firstStep = shape.steps[0].statement;
  const guardsFirst = shape.guards.every((guard) => guard.index < shape.statements.indexOf(firstStep));
  if (!guardsFirst) return;
  const [guard] = shape.guards;
  const entity = orFail && repositoryEntity(shape.repositoryText, sourceFile);
  const importEdits = orFail && typeormImport(sourceFile, notFoundErrorName);
  if (orFail && (!entity || !importEdits)) return;
  const checksAffected = orFail
    ? freeResultName(shape)
    : shape.guards.length === 1 && guard.throws && guard.index === shape.loadIndex + 1 && freeResultName(shape);
  const rewriteFrom = shape.guards.length && !checksAffected ? firstStep : shape.statement;
  // Once the lookup is gone, update() must skip the soft-deleted rows the lookup skipped.
  const updateWhere =
    rewriteFrom === shape.statement ? liveRowsWhere(shape, sourceFile, load) : { text: whereText, edits: [] };
  if (!updateWhere) return;
  const start = rewriteFrom.getStart();
  const end = shape.saveStatement.end;
  const replaced = text.slice(start, end);
  if (replaced.includes('//') || replaced.includes('/*')) return;
  const lines = plannedStatements(shape, updateWhere.text);
  const split = lines.length > 1;
  if (checksAffected) {
    lines[0] = `const ${checksAffected} = ${lines[0]}`;
    const failure = orFail
      ? `throw new ${notFoundErrorName}(${entity}, ${whereText});`
      : guard.statement.thenStatement.getText();
    lines.push(`if (!${checksAffected}.affected) ${failure}`);
  }
  const indentation = indentationAt(text, start);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const fix = { edits: [{ start, end, text: lines.join(`;${eol}${indentation}`) + (checksAffected ? '' : ';') }] };
  const addedImports = [...(orFail ? importEdits : []), ...updateWhere.edits];
  if (addedImports.length) fix.edits.push(mergedImportEdit(addedImports));
  const notes = [];
  if (split) {
    fix.requiresReview = true;
    notes.push(splitNote);
  }
  if (checksAffected) notes.push(affectedNote);
  if (updateWhere.column)
    notes.push(`\`${updateWhere.column}: ${isNullName}()\` keeps soft-deleted rows out, as the lookup did.`);
  if (notes.length) fix.note = notes.join(' ');
  return fix;
}

// Both import additions insert after the same last name, so they become one edit.
function mergedImportEdit(edits) {
  return { start: edits[0].start, end: edits[0].end, text: edits.map((edit) => edit.text).join('') };
}

module.exports = {
  'typeorm-load-then-save': requireReview(
    'update() skips entity hooks, subscribers and cascades that load-then-save ran.',
    loadThenSaveFix,
  ),
};
