'use strict';

const { ts, calleeCall, indentationAt } = require('./helpers.cjs');
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

function loadThenSaveFix({ node, text }) {
  const call = calleeCall(node);
  const shape = call && loadThenSaveShape(call);
  if (!shape?.steps.length || shape.method.endsWith('OrFail') || !isSimpleWhere(shape.where)) return;
  if (hasNewlineOrDuplicate(shape)) return;
  const whereText = shape.where.getText();
  const firstStep = shape.steps[0].statement;
  const guardsFirst = shape.guards.every((guard) => guard.index < shape.statements.indexOf(firstStep));
  if (!guardsFirst) return;
  const [guard] = shape.guards;
  const checksAffected =
    shape.guards.length === 1 && guard.throws && guard.index === shape.loadIndex + 1 && freeResultName(shape);
  const rewriteFrom = shape.guards.length && !checksAffected ? firstStep : shape.statement;
  const start = rewriteFrom.getStart();
  const end = shape.saveStatement.end;
  const replaced = text.slice(start, end);
  if (replaced.includes('//') || replaced.includes('/*')) return;
  const lines = plannedStatements(shape, whereText);
  if (checksAffected) {
    lines[0] = `const ${checksAffected} = ${lines[0]}`;
    lines.push(`if (!${checksAffected}.affected) ${guard.statement.thenStatement.getText()}`);
  }
  const indentation = indentationAt(text, start);
  const fix = { edits: [{ start, end, text: lines.join(`;\n${indentation}`) + (checksAffected ? '' : ';') }] };
  if (checksAffected) fix.note = affectedNote;
  return fix;
}

module.exports = { 'typeorm-load-then-save': loadThenSaveFix };
