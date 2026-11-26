// Credentials written into source: known token shapes, signing keys and named secret values.
import { ts } from '../../performance/compiler.js';
import { classifyExecutionContext } from '../../shared/execution-context.js';
import {
  fileMentions,
  libraryInfo,
  libraryFunction,
  resolveConstant,
  propertyKeyName,
  lastSegment,
  nameWords,
} from './shared.js';
import type {
  CallExpression,
  Expression,
  Node,
  PropertyAssignment,
  StringLiteralLike,
  TemplateLiteralLikeNode,
} from 'typescript';
import type { CheckerAdapter, SecurityRuleContext } from '../../shared/types.js';

const message =
  'A credential is hardcoded here and will be readable by anyone with the repository or the build. Load it from the environment or a secret manager and rotate the exposed value.';
const lowEntropyReason = 'The value has low entropy; confirm it is a real credential and not a label or sample.';

const credentialShapes = [
  /\b[sr]k_live_[0-9A-Za-z]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bwhsec_[A-Za-z0-9]{16,}/,
  /\bnpm_[A-Za-z0-9]{36}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----\s*[A-Za-z0-9+/=\s]{40,}/,
];
// Quick gate so that ordinary strings skip the shape regexes.
const credentialMarker = /_live_|AKIA|gh[pousr]_|github_pat_|xox[baprs]-|AIza|SG\.|glpat-|whsec_|npm_|PRIVATE KEY/;
const shortestKnownCredential = 20;
const shortestNamedSecret = 12;
const shortestSigningKey = 6;
const highEntropyBits = 3.2;
const highEntropyClasses = 3;
const namedSecretSuffixes = [
  'secret',
  'password',
  'passwd',
  'apikey',
  'jwtsecret',
  'privatekey',
  'accesstoken',
  'authtoken',
  'clientsecret',
  'encryptionkey',
];
const strongPlaceholderFragments = [
  'changeme',
  'change-me',
  'change_me',
  'your',
  'xxx',
  'example',
  'dummy',
  'placeholder',
  'replace',
  'todo',
  'sample',
  'insert',
  'redacted',
  'fake',
  '<',
  '>',
  '${',
  '***',
  '...',
];
const placeholderWords = new Set([
  'secret',
  'password',
  'passwd',
  'test',
  'dev',
  'default',
  'demo',
  'foo',
  'bar',
  'local',
  'localhost',
  'none',
  'null',
  'undefined',
  'token',
  'key',
  'admin',
  'abc',
  'my',
  'super',
  'jwt',
  'api',
  'access',
  'auth',
  'the',
  'for',
  'this',
  'is',
  'here',
  'string',
  'value',
  'random',
  'some',
]);
const sampleNameWords = new Set(['example', 'examples', 'sample', 'demo', 'mock', 'fake', 'dummy', 'fixture', 'seed']);
const sampleFileName = /example|swagger|openapi|mock|fixture|seed|demo|sample|stub/i;
// Publishable keys are meant to ship in client code: PostHog project keys and Stripe publishable
// keys.
const publicKeyShape = /^(?:phc_|pk_(?:live|test)_)/;
const signingKeyCalls: Record<string, Set<string>> = {
  jsonwebtoken: new Set(['sign', 'verify']),
  crypto: new Set(['createHmac']),
};

function isEnvironmentVariableName(value: string) {
  return /^[A-Z][A-Z0-9_]*$/.test(value);
}

// Letters in any script, so translated labels such as 'API-Schlüssel' count too.
function isIdentifierLike(value: string) {
  return /^\p{L}+(?:[-_. :/]\p{L}+)*$/u.test(value);
}

function isUrlOrPath(value: string) {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|\.{0,2}\/)/i.test(value);
}

function hasStrongPlaceholder(value: string) {
  const lowered = value.toLowerCase();
  return strongPlaceholderFragments.some((fragment) => lowered.includes(fragment));
}

function isPlaceholder(value: string, name: string) {
  if (hasStrongPlaceholder(value)) return true;
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  if (name && normalized === name.toLowerCase().replaceAll(/[^a-z0-9]/g, '')) return true;
  return nameWords(value).every((word) => placeholderWords.has(word) || /^\d+$/.test(word));
}

function characterClasses(value: string) {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length;
}

function shannonEntropy(value: string) {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function hasSecretName(name: string) {
  const normalized = name.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  return namedSecretSuffixes.some((suffix) => normalized.endsWith(suffix));
}

function isRepeatedCharacters(value: string) {
  return new Set(value).size <= 2;
}

function checkKnownCredential(literal: StringLiteralLike | TemplateLiteralLikeNode, context: SecurityRuleContext) {
  const text = literal.text ?? ('rawText' in literal ? literal.rawText : undefined);
  if (!text || text.length < shortestKnownCredential || !credentialMarker.test(text)) return;
  if (publicKeyShape.test(text) || hasStrongPlaceholder(text) || !credentialShapes.some((shape) => shape.test(text)))
    return;
  const isFixture =
    !context.fileContext.isTestSource && classifyExecutionContext(context.sourceFile).runtime === 'test-fixture';
  context.report(
    literal,
    'hardcoded-secret',
    message,
    isFixture ? 'Credential-shaped literal in a test or fixture source.' : undefined,
  );
}

function environmentName(expression: Expression) {
  const node = ts.skipOuterExpressions(expression);
  const key = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      ? node.argumentExpression.text
      : undefined;
  const object =
    ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : undefined;
  return object && object.getText() === 'process.env' ? key : undefined;
}

// The names a literal is stored under: through `process.env.X || 'literal'` fallbacks, then its
// declaration.
function targetNames(literal: Node): string[] {
  const names: (string | undefined)[] = [];
  let current = literal;
  for (;;) {
    const parent = current.parent;
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) {
      current = parent;
    } else if (
      ts.isBinaryExpression(parent) &&
      parent.right === current &&
      (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      names.push(environmentName(parent.left));
      current = parent;
    } else break;
  }
  const parent = current.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === current && ts.isIdentifier(parent.name))
    names.push(parent.name.text);
  else if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))
    names.push(propertyKeyName(parent.name));
  else if (ts.isParameter(parent) && parent.initializer === current && ts.isIdentifier(parent.name))
    names.push(parent.name.text);
  else if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === current
  )
    names.push(lastSegment(parent.left));
  return names.filter((name): name is string => Boolean(name));
}

function checkNamedSecret(literal: StringLiteralLike, context: SecurityRuleContext) {
  const value = literal.text;
  if (value.length < shortestNamedSecret || /\s/.test(value)) return;
  const name = targetNames(literal).find(hasSecretName);
  if (!name) return;
  if (isEnvironmentVariableName(value) || isUrlOrPath(value) || isIdentifierLike(value)) return;
  if (publicKeyShape.test(value)) return;
  if (isPlaceholder(value, name)) return;
  if (characterClasses(value) < 2) return;
  if (isRepeatedCharacters(value)) return;
  const strong = characterClasses(value) >= highEntropyClasses && shannonEntropy(value) >= highEntropyBits;
  if (strong) return context.report(literal, 'hardcoded-secret', message);
  context.report(literal, 'hardcoded-secret', message, lowEntropyReason);
}

function isSampleName(name: string | undefined) {
  return name !== undefined && nameWords(name).some((word) => sampleNameWords.has(word));
}

// API documentation samples (`@ApiBody({ example: { password: 'Pass123!' } })`,
// `REGISTRATION_EXAMPLE = {...}`) are not credentials.
function isDocumentationSample(literal: Node, context: SecurityRuleContext) {
  if (sampleFileName.test(context.sourceFile.fileName.split(/[\\/]/).pop() ?? '')) return true;
  return Boolean(
    ts.findAncestor(literal, (node: Node) => {
      if (ts.isDecorator(node)) return true;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return isSampleName(node.name.text);
      if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node))
        return isSampleName(propertyKeyName(node.name));
      return false;
    }),
  );
}

function checkStringLiteral(literal: StringLiteralLike, context: SecurityRuleContext) {
  if (literal.text === undefined) return;
  checkKnownCredential(literal, context);
  if (context.fileContext.isTestSource || context.sourceFile.isDeclarationFile) return;
  if (!isDocumentationSample(literal, context)) checkNamedSecret(literal, context);
}

function checkTemplateText(template: TemplateLiteralLikeNode, context: SecurityRuleContext) {
  checkKnownCredential(template, context);
}

// The literal behind a signing-key argument, through `process.env.X || 'literal'` and a same-file
// const.
function keyLiteral(expression: Expression, checker: CheckerAdapter): StringLiteralLike | undefined {
  const node = ts.skipOuterExpressions(expression);
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  )
    return keyLiteral(node.right, checker);
  const resolved = resolveConstant(node, checker);
  if (ts.isStringLiteralLike(resolved)) return resolved;
}

function reportSigningKey(keyExpression: Expression, context: SecurityRuleContext) {
  const literal = keyLiteral(keyExpression, context.checker);
  if (!literal || literal.text.length < shortestSigningKey || hasStrongPlaceholder(literal.text)) return;
  if (isEnvironmentVariableName(literal.text) || publicKeyShape.test(literal.text)) return;
  context.report(literal, 'hardcoded-secret', message);
}

function checkSigningKey(call: CallExpression, context: SecurityRuleContext) {
  if (context.fileContext.isTestSource || context.sourceFile.isDeclarationFile) return;
  if (!fileMentions(context.sourceFile, ['jsonwebtoken', 'crypto', 'express-session'])) return;
  const info = libraryInfo(call, context);
  if (!info?.module) return;
  if (info.module === 'express-session') {
    const options = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
    const property =
      options &&
      ts.isObjectLiteralExpression(options) &&
      options.properties.find(
        (member): member is PropertyAssignment =>
          ts.isPropertyAssignment(member) && propertyKeyName(member.name) === 'secret',
      );
    if (property) reportSigningKey(property.initializer, context);
    return;
  }
  const name = libraryFunction(call, context, Object.keys(signingKeyCalls));
  if (name && signingKeyCalls[info.module]?.has(name) && call.arguments[1])
    reportSigningKey(call.arguments[1], context);
}

export { checkStringLiteral, checkTemplateText, checkSigningKey };
