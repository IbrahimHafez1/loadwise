'use strict';

const { ts, calleeCall, indentationAt, nameTaken } = require('./helpers.cjs');
const { loadThenSaveShape, mentions } = require('../typeorm-updates.cjs');

const resultNames = ['result', 'updateResult'];
// update() with a non-unique where would touch every matching row, so only a primary-key lookup is rewritten.
const uniqueKey = 'id';
const affectedNote = '`affected` is not reported by every database driver; confirm yours returns it.';

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

// The entity class named in the receiver's `Repository<Entity>` declaration, such as `users: Repository<User>`.
function repositoryEntity(repositoryText, sourceFile) {
  const name = repositoryText.split('.').at(-1);
  let entity;
  (function visit(node) {
    const declared = ts.isPropertyDeclaration(node) || ts.isParameter(node) || ts.isVariableDeclaration(node);
    if (declared && node.name.getText() === name && node.type && ts.isTypeReferenceNode(node.type)) {
      const [argument] = node.type.typeArguments ?? [];
      if (node.type.typeName.getText() === 'Repository' && argument && ts.isTypeReferenceNode(argument)) {
        entity ??= argument.getText();
      }
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  return entity;
}

// Adds EntityNotFoundError to the `typeorm` import, or nothing when the file cannot import it that way.
function notFoundErrorImport(sourceFile) {
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
  if (elements.some((element) => element.name.text === notFoundErrorName)) return [];
  if (nameTaken(sourceFile, notFoundErrorName) || !elements.length) return;
  return [{ start: elements.at(-1).end, end: elements.at(-1).end, text: `, ${notFoundErrorName}` }];
}

function loadThenSaveFix({ node, text, sourceFile }) {
  const call = calleeCall(node);
  const shape = call && loadThenSaveShape(call);
  if (!shape?.steps.length || !isSimpleWhere(shape.where)) return;
  const orFail = shape.method.endsWith('OrFail');
  if (orFail && shape.guards.length) return;
  if (hasNewlineOrDuplicate(shape)) return;
  const whereText = shape.where.getText();
  const firstStep = shape.steps[0].statement;
  const guardsFirst = shape.guards.every((guard) => guard.index < shape.statements.indexOf(firstStep));
  if (!guardsFirst) return;
  const [guard] = shape.guards;
  const entity = orFail && repositoryEntity(shape.repositoryText, sourceFile);
  const importEdits = orFail && notFoundErrorImport(sourceFile);
  if (orFail && (!entity || !importEdits)) return;
  const checksAffected = orFail
    ? freeResultName(shape)
    : shape.guards.length === 1 && guard.throws && guard.index === shape.loadIndex + 1 && freeResultName(shape);
  const rewriteFrom = shape.guards.length && !checksAffected ? firstStep : shape.statement;
  const start = rewriteFrom.getStart();
  const end = shape.saveStatement.end;
  const replaced = text.slice(start, end);
  if (replaced.includes('//') || replaced.includes('/*')) return;
  const lines = plannedStatements(shape, whereText);
  if (checksAffected) {
    lines[0] = `const ${checksAffected} = ${lines[0]}`;
    const failure = orFail
      ? `throw new ${notFoundErrorName}(${entity}, ${whereText});`
      : guard.statement.thenStatement.getText();
    lines.push(`if (!${checksAffected}.affected) ${failure}`);
  }
  const indentation = indentationAt(text, start);
  const fix = { edits: [{ start, end, text: lines.join(`;\n${indentation}`) + (checksAffected ? '' : ';') }] };
  if (orFail) fix.edits.push(...importEdits);
  if (checksAffected) fix.note = affectedNote;
  return fix;
}

module.exports = { 'typeorm-load-then-save': loadThenSaveFix };
