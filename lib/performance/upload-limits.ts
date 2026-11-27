import { ts } from './compiler.js';
import type { CallExpression, Expression, ObjectLiteralElementLike, ObjectLiteralExpression } from 'typescript';
import type { PerformanceRuleContext } from '../shared/types.js';

// Position of the options argument for each upload helper.
const NEST_INTERCEPTORS = new Map([
  ['FileInterceptor', 1],
  ['FilesInterceptor', 2],
  ['FileFieldsInterceptor', 1],
  ['AnyFilesInterceptor', 0],
]);
const NEST_PACKAGES = ['@nestjs/platform-express'];
const MULTER_PACKAGES = ['multer', '@types/multer'];

function propertyName(property: ObjectLiteralElementLike): string | undefined {
  if (ts.isSpreadAssignment(property)) return;
  const name = property.name;
  if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) return name.text;
}

function findProperty(literal: ObjectLiteralExpression, name: string): ObjectLiteralElementLike | undefined {
  return literal.properties.find((property) => propertyName(property) === name);
}

function hasUnknownMember(literal: ObjectLiteralExpression): boolean {
  return literal.properties.some((property) => ts.isSpreadAssignment(property) || propertyName(property) === undefined);
}

// 'limited' when fileSize is set or cannot be judged statically, otherwise 'missing'.
function limitStatus(options: Expression | undefined): 'limited' | 'missing' {
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

function optionsIndex(callee: Expression): number | undefined {
  if (ts.isIdentifier(callee) && NEST_INTERCEPTORS.has(callee.text)) return NEST_INTERCEPTORS.get(callee.text);
  if (ts.isIdentifier(callee) && callee.text === 'multer') return 0;
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'multer') return 0;
}

// MulterModule.register({ limits }) in another file also caps uploads; that is not visible from
// here.
function check(node: CallExpression, context: PerformanceRuleContext): void {
  const callee = node.expression;
  const index = optionsIndex(callee);
  if (index === undefined) return;
  if (!ts.isIdentifier(callee) && !ts.isPropertyAccessExpression(callee)) return;
  const packages =
    (ts.isIdentifier(callee) && callee.text === 'multer') || ts.isPropertyAccessExpression(callee)
      ? MULTER_PACKAGES
      : NEST_PACKAGES;
  if (!context.isPackageType(callee, packages)) return;
  if (limitStatus(node.arguments[index]) !== 'missing') return;
  const name = ts.isIdentifier(callee) ? callee.text : callee.name.text;
  context.report(
    callee,
    'upload-without-size-limit',
    `\`${name}\` has no local \`limits.fileSize\`. Large files can exhaust memory with memory storage. Check the application's effective upload limits, including any global Multer configuration, and choose a byte limit that supports the files this endpoint accepts.`,
  );
}

export { check };
