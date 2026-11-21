'use strict';

const { ts, calleeCall, indentationAt } = require('./helpers.cjs');

const SIZE_LIMIT = 'fileSize: 10 * 1024 * 1024';
const optionsIndexByName = {
  FileInterceptor: 1,
  FilesInterceptor: 2,
  FileFieldsInterceptor: 1,
  AnyFilesInterceptor: 0,
  multer: 0,
};

function propertyNamed(literal, name) {
  return literal.properties.find((property) => property.name && property.name.text === name);
}

// Adds `property` to an object literal, on its own line when the literal is already multi-line.
function addProperty(literal, property, text) {
  const lastProperty = literal.properties.at(-1);
  if (!lastProperty) return { start: literal.getStart(), end: literal.end, text: `{ ${property} }` };
  if (!text.slice(literal.getStart(), lastProperty.getStart()).includes('\n'))
    return { start: lastProperty.end, end: lastProperty.end, text: `, ${property}` };
  const indentation = indentationAt(text, lastProperty.getStart());
  if (literal.properties.hasTrailingComma) {
    const insertAt = text.indexOf(',', lastProperty.end) + 1;
    return { start: insertAt, end: insertAt, text: `\n${indentation}${property},` };
  }
  return { start: lastProperty.end, end: lastProperty.end, text: `,\n${indentation}${property}` };
}

function uploadLimitEdit({ node, text }) {
  const call = calleeCall(node);
  const callee = call && (ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression);
  const index = callee && optionsIndexByName[callee.text];
  if (index === undefined) return;
  const limits = `limits: { ${SIZE_LIMIT} }`;
  const options = call.arguments[index];
  if (!options) {
    if (call.arguments.length !== index) return;
    if (!index) return { start: call.arguments.pos, end: call.arguments.pos, text: `{ ${limits} }` };
    const last = call.arguments.at(-1);
    return { start: last.end, end: last.end, text: `, { ${limits} }` };
  }
  const literal = ts.skipOuterExpressions(options);
  if (!ts.isObjectLiteralExpression(literal)) return;
  const existing = propertyNamed(literal, 'limits');
  if (!existing) return addProperty(literal, limits, text);
  const limitsLiteral = ts.isPropertyAssignment(existing) && ts.skipOuterExpressions(existing.initializer);
  if (!limitsLiteral || !ts.isObjectLiteralExpression(limitsLiteral)) return;
  return addProperty(limitsLiteral, SIZE_LIMIT, text);
}

function uploadLimitFix(site) {
  const edit = uploadLimitEdit(site);
  if (!edit) return;
  return {
    edits: [edit],
    requiresReview: true,
    note: '10 MiB is an example. Confirm which file sizes this endpoint must accept and check the gateway request limit. Preserve any inherited Multer limits when setting route options.',
  };
}

module.exports = { 'upload-without-size-limit': uploadLimitFix };
