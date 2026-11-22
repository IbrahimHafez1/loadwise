'use strict';

const { ts, calleeCall, indentationAt, nameTaken } = require('./helpers.cjs');

const LIMIT_NAME = 'MAX_UPLOAD_FILE_SIZE_BYTES';
const LIMIT_DECLARATION = `const ${LIMIT_NAME} = 10 * 1024 * 1024;`;
const SIZE_LIMIT = `fileSize: ${LIMIT_NAME}`;
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

// A named constant, placed after the imports, keeps the placeholder easy to find and to change in one place.
function limitDeclarationEdit({ sourceFile, text }) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  if (!imports.length) return { start: 0, end: 0, text: LIMIT_DECLARATION + newline + newline };
  const position = imports.at(-1).end;
  return { start: position, end: position, text: newline + newline + LIMIT_DECLARATION };
}

function uploadLimitFix(site) {
  if (nameTaken(site.sourceFile, LIMIT_NAME)) return;
  const edit = uploadLimitEdit(site);
  if (!edit) return;
  return {
    edits: [edit, limitDeclarationEdit(site)],
    requiresReview: true,
    // Every upload site in a file adds the same declaration, so it has to stay a separate, shareable hunk.
    separateEdits: true,
    note: `${LIMIT_NAME} is a placeholder of 10 MiB, not a recommendation. Choose the limit against a real upload (a workbook with embedded images can be larger) and check the gateway request limit. Preserve any inherited Multer limits when setting route options.`,
  };
}

module.exports = { 'upload-without-size-limit': uploadLimitFix };
