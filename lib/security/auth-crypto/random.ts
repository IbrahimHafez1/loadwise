// Math.random() output that ends up as a token, code or secret.
import { ts } from '../../performance/compiler.js';
import { propertyKeyName, lastSegment, nameWords, enclosingFunction, functionName, referencesOf } from './shared.js';
import type { CallExpression, Node } from 'typescript';
import type { SecurityRuleContext } from '../../shared/types.js';

const secretSubstrings = /token|secret|password|passwd|nonce|session|apiKey|resetCode|verif|invite|coupon|csrf/i;
// Short words that appear inside unrelated names (`mapping`, `footprint`, `asalt`), so they must be
// whole words.
const secretWords = new Set(['pin', 'otp', 'salt']);
const harmlessName = /jitter|delay|backoff|retry|sample|shuffle|color|index|offset|percent/i;
const identifierName = /^id$|[a-z0-9]Id$/;
const valueCarryingMathFunctions = new Set(['floor', 'round', 'ceil', 'trunc', 'abs']);
const valueCarryingConversions = new Set(['String', 'Number', 'parseInt', 'parseFloat', 'BigInt']);
const valueCarryingStringMethods = new Set([
  'toString',
  'substring',
  'substr',
  'slice',
  'toFixed',
  'toUpperCase',
  'toLowerCase',
  'padStart',
  'padEnd',
  'replace',
  'concat',
]);
const carryingOperators = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);
const followDepthLimit = 2;
const message =
  '`Math.random()` is predictable and must not produce tokens, codes or secrets. Use `crypto.randomBytes`, `crypto.randomInt` or `crypto.randomUUID`.';

function isMathRandomCall(node: CallExpression) {
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'random' &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Math'
  );
}

function classifyName(name: string | undefined) {
  if (!name || harmlessName.test(name)) return;
  if (secretSubstrings.test(name) || nameWords(name).some((word) => secretWords.has(word))) return 'secret';
  if (identifierName.test(name)) return 'identifier';
}

function valueCarryingParent(current: Node): Node | undefined {
  const parent = current.parent;
  if (
    (ts.isOuterExpression(parent) && parent.expression === current) ||
    ts.isConditionalExpression(parent) ||
    ts.isTemplateSpan(parent) ||
    ts.isTemplateExpression(parent)
  )
    return parent;
  if (ts.isBinaryExpression(parent) && carryingOperators.has(parent.operatorToken.kind)) return parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
    const call = parent.parent;
    if (ts.isCallExpression(call) && call.expression === parent && valueCarryingStringMethods.has(parent.name.text))
      return call;
  }
  if (ts.isCallExpression(parent) && parent.arguments.some((argument) => argument === current)) {
    const callee = ts.skipOuterExpressions(parent.expression);
    const carries = ts.isPropertyAccessExpression(callee)
      ? ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'Math' &&
        valueCarryingMathFunctions.has(callee.name.text)
      : ts.isIdentifier(callee) && valueCarryingConversions.has(callee.text);
    if (carries) return parent;
  }
}

// Chase only a bounded number of local aliases; terminal assignments and returns need no reference
// search.
function landingNames(start: Node, context: SecurityRuleContext, depth = 0): (string | undefined)[] {
  let current = start;
  for (let next: Node | undefined; current.parent && (next = valueCarryingParent(current));) current = next;
  const parent = current.parent;
  if (!parent) return [];
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === current
  )
    return [lastSegment(parent.left)];
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return [propertyKeyName(parent.name)];
  if (ts.isParameter(parent) && parent.initializer === current)
    return ts.isIdentifier(parent.name) ? [parent.name.text] : [];
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const names: (string | undefined)[] = [parent.name.text];
    if (depth < followDepthLimit) {
      const scope = enclosingFunction(parent) ?? context.sourceFile;
      for (const reference of referencesOf(parent.name, scope, context.checker))
        names.push(...landingNames(reference, context, depth + 1));
    }
    return names;
  }
  if (ts.isReturnStatement(parent)) {
    const fn = enclosingFunction(parent);
    return fn ? [functionName(fn)] : [];
  }
  if (ts.isArrowFunction(parent) && parent.body === current) return [functionName(parent)];
  return [];
}

function checkMathRandom(call: CallExpression, context: SecurityRuleContext) {
  if (!isMathRandomCall(call)) return;
  const classes = landingNames(call, context).map(classifyName);
  if (classes.includes('secret')) return context.report(call, 'insecure-random-for-secret', message);
  if (classes.includes('identifier'))
    context.report(
      call,
      'insecure-random-for-secret',
      message,
      'The value is only used as an identifier; confirm it is not a secret or capability.',
    );
}

export { checkMathRandom };
