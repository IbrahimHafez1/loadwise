// nest-validation-without-whitelist: a ValidationPipe that keeps properties the DTO does not
// declare.
import { ts } from '../../performance/compiler.js';
import { importedFrom } from '../bindings.js';
import { objectLiteralOf, findProperty, isFullyLiteral, isTrue, unwrap } from './literals.js';
import type { CallExpression, Expression, NewExpression } from 'typescript';
import type { RuleContext } from '../../shared/types.js';

const ruleId = 'nest-validation-without-whitelist';
const message =
  'This `ValidationPipe` keeps properties that the DTO does not declare, so extra fields reach your handlers. Set `whitelist: true` (and `forbidNonWhitelisted: true` to reject them).';
const unrejectedReason =
  'Unknown properties are stripped but not rejected; set `forbidNonWhitelisted: true` to reject them.';

function isValidationPipe(expression: Expression, context: RuleContext) {
  const callee = unwrap(expression);
  if (!ts.isIdentifier(callee)) return false;
  const binding = importedFrom(callee, context.checker);
  return binding?.module === '@nestjs/common' && binding.exported === 'ValidationPipe';
}

function check(node: CallExpression | NewExpression, context: RuleContext) {
  if (!isValidationPipe(node.expression, context)) return;
  const [optionsArgument] = node.arguments ?? [];
  if (!optionsArgument) return context.report(node, ruleId, message);
  const options = objectLiteralOf(optionsArgument, context.checker);
  if (!options || !isFullyLiteral(options)) return;
  const whitelist = findProperty(options, 'whitelist');
  if (!whitelist || !isTrue(whitelist.value)) {
    // Only a missing key or a literal `false` proves the pipe keeps extras; any other expression
    // may be true.
    if (whitelist && whitelist.value.kind !== ts.SyntaxKind.FalseKeyword) return;
    return context.report(node, ruleId, message);
  }
  if (!findProperty(options, 'forbidNonWhitelisted')) context.report(node, ruleId, message, unrejectedReason);
}

export { check };
