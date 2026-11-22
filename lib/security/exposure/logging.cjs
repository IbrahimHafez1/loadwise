'use strict';

// secret-in-log: a credential-like value passed to a logger call.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { unwrap, nameText, chainRootName } = require('./literals.cjs');

const ruleId = 'secret-in-log';
const logMethods = new Set(['log', 'info', 'debug', 'warn', 'error', 'verbose', 'trace', 'fatal']);
// The full last name segment; `tokenId`, `hasPassword` and `tokens` describe the secret without being it.
const secretNamePattern =
  /^(?:password|passwd|pwd|secret|clientSecret|token|accessToken|refreshToken|idToken|apiKey|authorization|cookie|privateKey|cardNumber|cvv|ssn)$/i;
const loggerNamePattern = /^(?:console|log|logger|_logger)$|Logger$/;
const requestPattern = /^(?:req|request)$/;
const requestObjectNames = new Set(['body', 'headers']);
const joiningOperators = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
]);
const wholeRequestReason = 'The whole request is logged; confirm it carries no credentials.';
const commandSource = /\.command\.[cm]?[jt]s$/i;
const commandPackages = new Set(['commander', 'nest-commander']);
const credentialFactory = /^(?:generate|create|issue|mint)(?:[A-Z]\w*)?(?:Token|Key|Secret|Password)$/;

function isLoggerCall(call) {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !logMethods.has(callee.name.text)) return false;
  const receiver = unwrap(callee.expression);
  const name = ts.isIdentifier(receiver)
    ? receiver.text
    : ts.isPropertyAccessExpression(receiver)
      ? receiver.name.text
      : '';
  return loggerNamePattern.test(name);
}

function isScalarType(node, checker) {
  const type = checker.getTypeAtLocation(node);
  return Boolean(type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike));
}

function lastSegment(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return node.argumentExpression.text;
}

function isJsonStringify(node) {
  const callee = unwrap(node.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'stringify' &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'JSON'
  );
}

// A replacer function that names a secret, as in `(key, value) => (/password/i.test(key) ? '***' : value)`.
const maskedSecretWords = /password|passwd|secret|token|authorization|apikey|api_key|cookie/i;

function isMaskingReplacer(argument, checker) {
  let replacer = unwrap(argument);
  if (replacer && ts.isIdentifier(replacer)) {
    const declaration = checker.getSymbolAtLocation(replacer)?.valueDeclaration;
    replacer = declaration && ts.isVariableDeclaration(declaration) ? unwrap(declaration.initializer) : declaration;
  }
  return Boolean(replacer) && ts.isFunctionLike(replacer) && maskedSecretWords.test(replacer.getText());
}

function isWholeRequest(node, checker) {
  let expression = unwrap(node);
  if (ts.isCallExpression(expression) && isJsonStringify(expression)) {
    if (isMaskingReplacer(expression.arguments[1], checker)) return false;
    expression = unwrap(expression.arguments[0]);
  }
  if (!expression) return false;
  return (
    ts.isPropertyAccessExpression(expression) &&
    requestObjectNames.has(expression.name.text) &&
    requestPattern.test(chainRootName(expression) ?? '')
  );
}

// Secret-named values inside a logged argument. Calls are not entered: `mask(token)` and `token.slice(0, 4)`
// hand the log something other than the secret.
function collectSecrets(expression, secrets) {
  const node = unwrap(expression);
  if (!node) return;
  if (ts.isTemplateExpression(node))
    return node.templateSpans.forEach((span) => collectSecrets(span.expression, secrets));
  if (ts.isBinaryExpression(node) && joiningOperators.has(node.operatorToken.kind)) {
    collectSecrets(node.left, secrets);
    return collectSecrets(node.right, secrets);
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.forEach((element) => collectSecrets(element, secrets));
  if (ts.isObjectLiteralExpression(node))
    return node.properties.forEach((property) => collectProperty(property, secrets));
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    if (secretNamePattern.test(lastSegment(node) ?? '')) secrets.push({ node, name: lastSegment(node) });
}

function collectProperty(property, secrets) {
  if (ts.isShorthandPropertyAssignment(property)) {
    if (secretNamePattern.test(property.name.text)) secrets.push({ node: property, name: property.name.text });
    return;
  }
  if (ts.isSpreadAssignment(property)) return;
  if (!ts.isPropertyAssignment(property)) return;
  const value = unwrap(property.initializer);
  const key = nameText(property.name);
  const isReference =
    ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value);
  if (isReference && key && secretNamePattern.test(key)) secrets.push({ node: property, name: key });
  else collectSecrets(value, secrets);
}

function requestObjectText(argument) {
  const expression = unwrap(argument);
  return ts.isCallExpression(expression) ? unwrap(expression.arguments[0]).getText() : expression.getText();
}

function isCommandOutput(call, sourceFile) {
  if (!commandSource.test(sourceFile.fileName) || call.expression.name?.text !== 'log') return false;
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      commandPackages.has(statement.moduleSpecifier.text),
  );
}

function isNewCredential(node, call, checker) {
  const value = ts.isShorthandPropertyAssignment(node) ? node.name : node;
  const binding = ts.isPropertyAccessExpression(value) ? unwrap(value.expression) : value;
  if (!ts.isIdentifier(binding)) return false;
  const declaration = checker.getSymbolAtLocation(binding)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const))
    return false;
  if (ts.findAncestor(declaration, ts.isFunctionLike) !== ts.findAncestor(call, ts.isFunctionLike)) return false;
  let initializer = unwrap(declaration.initializer);
  if (initializer && ts.isAwaitExpression(initializer)) initializer = unwrap(initializer.expression);
  if (!initializer || !ts.isCallExpression(initializer)) return false;
  const factory = lastSegment(unwrap(initializer.expression));
  return Boolean(factory && credentialFactory.test(factory));
}

function check(call, context) {
  if (!isLoggerCall(call)) return;
  const commandOutput = isCommandOutput(call, context.sourceFile);
  for (const argument of call.arguments) {
    if (isWholeRequest(argument, context.checker)) {
      const name = requestObjectText(argument);
      context.report(argument, ruleId, messageFor(name), wholeRequestReason);
      continue;
    }
    const secrets = [];
    collectSecrets(argument, secrets);
    for (const { node, name } of secrets) {
      if (commandOutput && isNewCredential(node, call, context.checker)) continue;
      if (!isScalarType(ts.isShorthandPropertyAssignment(node) ? node.name : node, context.checker))
        context.report(node, ruleId, messageFor(name));
    }
  }
}

function messageFor(name) {
  return `\`${name}\` is written to the log, where it outlives the request and is readable by anyone with log access. Log an identifier or a redacted value instead.`;
}

module.exports = { check };
