import { ts } from './compiler.js';
import type { CallExpression, Expression, ObjectLiteralElementLike, ObjectLiteralExpression } from 'typescript';
import type { PerformanceRuleContext } from '../shared/types.js';

const RULE_ID = 'llm-call-without-max-tokens';
// The OpenAI resources whose create() has an optional output cap. Anthropic's messages.create is
// absent on purpose: its types require max_tokens, so the call cannot omit it.
const RESOURCE_TYPES = ['Completions', 'Responses'];
const OUTPUT_CAP_KEYS = new Set(['max_tokens', 'max_completion_tokens', 'max_output_tokens']);

function isOpenAiCreate(call: CallExpression, context: PerformanceRuleContext): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'create') return false;
  const resource = callee.expression;
  if (!ts.isPropertyAccessExpression(resource) || !['completions', 'responses'].includes(resource.name.text))
    return false;
  // The legacy `client.completions` resource takes only `max_tokens`, so the chat remedy would not apply.
  if (resource.name.text === 'completions' && !isChatResource(resource.expression)) return false;
  return context.isPackageType(resource, ['openai'], RESOURCE_TYPES);
}

function isChatResource(receiver: Expression): boolean {
  return ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'chat';
}

// `max_tokens: undefined` is dropped on serialization, so it sets no limit.
function isUnsetValue(property: ObjectLiteralElementLike): boolean {
  if (!ts.isPropertyAssignment(property)) return false;
  const value = ts.skipOuterExpressions(property.initializer);
  return value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === 'undefined');
}

// True when the key set is fully known and holds no output cap. A spread or computed key may carry
// the cap from elsewhere, so those calls stay quiet.
function lacksOutputCap(options: ObjectLiteralExpression): boolean {
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) return false;
    const name = property.name;
    if (!name) return false;
    if (ts.isComputedPropertyName(name)) return false;
    if (OUTPUT_CAP_KEYS.has(name.text) && !isUnsetValue(property)) return false;
  }
  return true;
}

function check(call: CallExpression, context: PerformanceRuleContext): void {
  const [firstArgument] = call.arguments;
  const options = firstArgument && ts.skipOuterExpressions(firstArgument);
  if (!options || !ts.isObjectLiteralExpression(options) || !lacksOutputCap(options)) return;
  if (!isOpenAiCreate(call, context)) return;
  context.report(
    call,
    RULE_ID,
    'This OpenAI call sets no output token limit, so a long or runaway completion is billed in full and holds the request open. Set `max_completion_tokens` (chat completions) or `max_output_tokens` (responses) to a limit the feature can justify.',
  );
}

export { check };
