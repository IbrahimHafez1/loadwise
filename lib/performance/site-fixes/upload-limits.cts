import { ts, addProperty, calleeCall, nameTaken } from './helpers.cjs';
import type { ObjectLiteralElementLike, ObjectLiteralExpression, SourceFile } from 'typescript';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.cjs';

const LIMIT_NAME = 'MAX_UPLOAD_FILE_SIZE_BYTES';
const LIMIT_DECLARATION = `const ${LIMIT_NAME} = 10 * 1024 * 1024;`;
const SIZE_LIMIT = `fileSize: ${LIMIT_NAME}`;
const optionsIndexByName: Record<string, number> = {
  FileInterceptor: 1,
  FilesInterceptor: 2,
  FileFieldsInterceptor: 1,
  AnyFilesInterceptor: 0,
  multer: 0,
};

function propertyNamed(literal: ObjectLiteralExpression, name: string): ObjectLiteralElementLike | undefined {
  return literal.properties.find(
    (property) => property.name && !ts.isComputedPropertyName(property.name) && property.name.text === name,
  );
}

function uploadLimitEdit({ node, text }: SiteFixInput): TextEdit | undefined {
  if (!node || text === undefined) return;
  const call = calleeCall(node);
  if (!call) return;
  const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  const index = ts.isIdentifier(callee) || ts.isPrivateIdentifier(callee) ? optionsIndexByName[callee.text] : undefined;
  if (index === undefined) return;
  const limits = `limits: { ${SIZE_LIMIT} }`;
  const options = call.arguments[index];
  if (!options) {
    if (call.arguments.length !== index) return;
    if (!index) return { start: call.arguments.pos, end: call.arguments.pos, text: `{ ${limits} }` };
    const last = call.arguments[index - 1];
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

// A named constant, placed after the imports, keeps the placeholder easy to find and to change in
// one place.
function limitDeclarationEdit(sourceFile: SourceFile, text: string): TextEdit {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  if (!imports.length) return { start: 0, end: 0, text: LIMIT_DECLARATION + newline + newline };
  const position = imports[imports.length - 1].end;
  return { start: position, end: position, text: newline + newline + LIMIT_DECLARATION };
}

function uploadLimitFix(site: SiteFixInput): FixResult | undefined {
  const { sourceFile, text } = site;
  if (!sourceFile || text === undefined) return;
  if (nameTaken(sourceFile, LIMIT_NAME)) return;
  const edit = uploadLimitEdit(site);
  if (!edit) return;
  return {
    edits: [edit, limitDeclarationEdit(sourceFile, text)],
    requiresReview: true,
    // Every upload site in a file adds the same declaration, so it has to stay a separate,
    // shareable hunk.
    separateEdits: true,
    note: `${LIMIT_NAME} is a placeholder of 10 MiB, not a recommendation. Choose the limit against a real upload (a workbook with embedded images can be larger) and check the gateway request limit. Preserve any inherited Multer limits when setting route options.`,
  };
}

export default { 'upload-without-size-limit': uploadLimitFix };
