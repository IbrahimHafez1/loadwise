'use strict';

const { syntax: ts } = require('./compiler.cjs');

// Position of the options argument for each upload helper.
const NEST_INTERCEPTORS = new Map([
  ['FileInterceptor', 1],
  ['FilesInterceptor', 2],
  ['FileFieldsInterceptor', 1],
  ['AnyFilesInterceptor', 0],
]);
const NEST_PACKAGES = ['@nestjs/platform-express'];
const MULTER_PACKAGES = ['multer', '@types/multer'];

function propertyName(property) {
  if (ts.isSpreadAssignment(property)) return;
  const name = property.name;
  if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) return name.text;
}

function findProperty(literal, name) {
  return literal.properties.find((property) => propertyName(property) === name);
}

function hasUnknownMember(literal) {
  return literal.properties.some((property) => ts.isSpreadAssignment(property) || propertyName(property) === undefined);
}

// 'limited' when fileSize is set or cannot be judged statically, otherwise 'missing'.
function limitStatus(options) {
  if (!options) return 'missing';
  const literal = ts.skipOuterExpressions(options);
  if (!ts.isObjectLiteralExpression(literal) || hasUnknownMember(literal)) return 'limited';
  const limits = findProperty(literal, 'limits');
  if (!limits) return 'missing';
  if (!ts.isPropertyAssignment(limits)) return 'limited';
  const limitsLiteral = ts.skipOuterExpressions(limits.initializer);
  if (!ts.isObjectLiteralExpression(limitsLiteral) || hasUnknownMember(limitsLiteral)) return 'limited';
  return findProperty(limitsLiteral, 'fileSize') ? 'limited' : 'missing';
}

function optionsIndex(callee) {
  if (ts.isIdentifier(callee) && NEST_INTERCEPTORS.has(callee.text)) return NEST_INTERCEPTORS.get(callee.text);
  if (ts.isIdentifier(callee) && callee.text === 'multer') return 0;
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'multer') return 0;
}

// MulterModule.register({ limits }) in another file also caps uploads; that is not visible from here.
function check(node, context) {
  const callee = node.expression;
  const index = optionsIndex(callee);
  if (index === undefined) return;
  const packages = callee.text === 'multer' || ts.isPropertyAccessExpression(callee) ? MULTER_PACKAGES : NEST_PACKAGES;
  if (!context.isPackageType(callee, packages)) return;
  if (limitStatus(node.arguments[index]) !== 'missing') return;
  const name = ts.isIdentifier(callee) ? callee.text : callee.name.text;
  context.report(
    callee,
    'upload-without-size-limit',
    `\`${name}\` has no \`limits.fileSize\`, so an upload is buffered (memory storage by default) with no ceiling and one large request can exhaust memory and parsing time. Set \`limits: { fileSize: 10 * 1024 * 1024 }\` and tune the number per endpoint. Ignore if a global \`MulterModule.register({ limits })\` already sets it.`,
  );
}

module.exports = { check };
