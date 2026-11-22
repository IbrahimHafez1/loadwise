'use strict';

const { syntax: ts } = require('./compiler.cjs');

const rule = 'http-call-without-timeout';
const axiosMethods = {
  get: { optionsIndex: 1 },
  delete: { optionsIndex: 1 },
  head: { optionsIndex: 1 },
  options: { optionsIndex: 1 },
  request: { optionsIndex: 0 },
  post: { optionsIndex: 2 },
  put: { optionsIndex: 2 },
  patch: { optionsIndex: 2 },
};
const clientExtensions = /\.[jt]sx$/i;
const testFile =
  /(?:\/(?:__tests__|__fixtures__|__mocks__|e2e|playwright|cypress)\/|\.(?:test|spec|e2e|e2e-spec|itest|e2e-test)\.[cm]?[jt]sx?$)/;
const libraryFile = /(?:\/node_modules\/|\/lib\.[\w.]*\.d\.ts$)/;
const clientOnlyDirectory = /\/client-only\//;
// React forbids hooks in server components, so a module that imports one renders in the browser.
const reactHooks = new Set([
  'useState',
  'useEffect',
  'useLayoutEffect',
  'useCallback',
  'useRef',
  'useMemo',
  'useReducer',
  'useContext',
  'useTransition',
]);
const browserGlobals = new Set(['window', 'document']);
const clientFiles = new WeakMap();

function skipParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

// Syntactic shape of a call this rule cares about: which argument holds the options and which keys count as a limit.
function describeCall(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee) && callee.text === 'fetch') {
    return { library: 'fetch', receiver: callee, optionsIndex: 1, limitKeys: ['signal'], limitProperty: 'signal' };
  }
  if (ts.isIdentifier(callee) && callee.text === 'axios') {
    const [first] = call.arguments;
    const optionsIndex = first && ts.isObjectLiteralExpression(skipParentheses(first)) ? 0 : 1;
    return {
      library: 'axios',
      receiver: callee,
      optionsIndex,
      limitKeys: ['timeout', 'signal'],
      limitProperty: 'timeout',
    };
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'axios' &&
    Object.hasOwn(axiosMethods, callee.name.text)
  ) {
    return {
      library: 'axios',
      receiver: callee.expression,
      optionsIndex: axiosMethods[callee.name.text].optionsIndex,
      limitKeys: ['timeout', 'signal'],
      limitProperty: 'timeout',
    };
  }
}

function hasUseClientDirective(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (statement.expression.text === 'use client') return true;
  }
  return false;
}

function importsClientModule(sourceFile) {
  return sourceFile.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
    const specifier = statement.moduleSpecifier.text;
    if (specifier === 'client-only') return true;
    const bindings = statement.importClause?.namedBindings;
    if (specifier !== 'react' || statement.importClause.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) {
      return false;
    }
    return bindings.elements.some(
      (element) => !element.isTypeOnly && reactHooks.has((element.propertyName ?? element.name).text),
    );
  });
}

function isImmediatelyInvoked(node) {
  let expression = node;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  return ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
}

// Unguarded `window.x` or `document.x` while the module loads throws in Node, so the file only runs in a browser.
function readsBrowserGlobalOnLoad(sourceFile, checker) {
  function visit(node) {
    if (ts.isFunctionLike(node)) return isImmediatelyInvoked(node) && node.body ? visit(node.body) : false;
    if (
      ts.isIfStatement(node) ||
      ts.isConditionalExpression(node) ||
      ts.isTryStatement(node) ||
      ts.isTypeOfExpression(node) ||
      (ts.isBinaryExpression(node) &&
        [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind))
    )
      return false;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      browserGlobals.has(node.expression.text) &&
      isAmbient(node.expression, checker)
    )
      return true;
    return ts.forEachChild(node, visit) ?? false;
  }
  return sourceFile.statements.some(visit);
}

// Browser code and test files talk to their own servers; a missing timeout there is not a server hazard.
function isClientFile(sourceFile, checker) {
  if (!clientFiles.has(sourceFile)) {
    const fileName = sourceFile.fileName.replaceAll('\\', '/');
    clientFiles.set(
      sourceFile,
      clientExtensions.test(fileName) ||
        testFile.test(fileName) ||
        clientOnlyDirectory.test(fileName) ||
        hasUseClientDirective(sourceFile) ||
        importsClientModule(sourceFile) ||
        readsBrowserGlobalOnLoad(sourceFile, checker),
    );
  }
  return clientFiles.get(sourceFile);
}

// Declared by lib.dom, undici or another package, not by the project.
function isAmbient(identifier, checker) {
  const declarations = checker.getSymbolAtLocation(identifier)?.declarations;
  if (!declarations?.length) return true;
  return declarations.every((declaration) =>
    libraryFile.test(declaration.getSourceFile().fileName.replaceAll('\\', '/')),
  );
}

// The global fetch (lib.dom / undici types), not a function the project named `fetch`.
function isGlobalFetch(callee, context) {
  return isAmbient(callee, context.checker);
}

function startsRootRelative(text) {
  return text.startsWith('/') && !text.startsWith('//');
}

function constInitializer(identifier, checker) {
  const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.parent.flags & ts.NodeFlags.Const &&
    declaration.initializer
  )
    return skipParentheses(declaration.initializer);
}

// Node's fetch rejects a URL without an origin, so `fetch('/api/x')` only ever runs in a browser.
function isRootRelativeUrl(argument, checker) {
  let url = skipParentheses(argument);
  if (ts.isIdentifier(url)) url = constInitializer(url, checker);
  if (!url) return false;
  if (ts.isConditionalExpression(url)) {
    return isRootRelativeUrl(url.whenTrue, checker) && isRootRelativeUrl(url.whenFalse, checker);
  }
  if (ts.isStringLiteral(url) || ts.isNoSubstitutionTemplateLiteral(url)) return startsRootRelative(url.text);
  return ts.isTemplateExpression(url) && startsRootRelative(url.head.text);
}

// `import axios from 'axios'` or `const axios = require('axios')`, for projects whose axios types do not resolve.
function importsDefaultAxios(receiver, checker) {
  const declaration = checker.getSymbolAtLocation(receiver)?.declarations?.[0];
  if (!declaration) return false;
  if (ts.isImportClause(declaration)) {
    const specifier = declaration.parent.moduleSpecifier;
    return !declaration.isTypeOnly && ts.isStringLiteral(specifier) && specifier.text === 'axios';
  }
  const initializer = ts.isVariableDeclaration(declaration) && constInitializer(declaration.name, checker);
  return (
    !!initializer &&
    ts.isCallExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === 'require' &&
    initializer.arguments.length === 1 &&
    ts.isStringLiteral(initializer.arguments[0]) &&
    initializer.arguments[0].text === 'axios'
  );
}

function isDefaultAxios(receiver, context) {
  if (context.isPackageType(receiver, ['axios'], ['AxiosStatic'])) return true;
  const unresolved = context.checker.getTypeAtLocation(receiver).flags & ts.TypeFlags.Any;
  return !!unresolved && importsDefaultAxios(receiver, context.checker);
}

function isRequestObject(argument, context) {
  return context.checker.getTypeAtLocation(argument).getSymbol()?.name === 'Request';
}

function propertyName(property) {
  if (!property.name) return;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
}

// True when the options literal is known to lack every limit key. Spreads and computed keys make that unknowable.
function literalLacksLimit(literal, limitKeys) {
  return literal.properties.every((property) => {
    if (ts.isSpreadAssignment(property)) return false;
    if (property.name && ts.isComputedPropertyName(property.name)) return false;
    return !limitKeys.includes(propertyName(property));
  });
}

// A const options object, unless the file may add a limit to it later (`options.timeout = …`, `Object.assign(options, …)`).
function unchangedOptionsLiteral(identifier, limitKeys, checker) {
  const literal = constInitializer(identifier, checker);
  if (!literal || !ts.isObjectLiteralExpression(literal)) return;
  if (literal.getSourceFile() !== identifier.getSourceFile()) return;
  const name = identifier.text.replaceAll('$', '\\$');
  const mutation = new RegExp(
    `\\b${name}\\s*(?:\\[|\\.\\s*(?:${limitKeys.join('|')})\\s*=)|Object\\.assign\\(\\s*${name}\\b`,
  );
  if (!mutation.test(identifier.getSourceFile().text)) return literal;
}

function check(node, context) {
  const target = describeCall(node);
  if (!target) return;
  const sourceFile = node.getSourceFile();
  if (node.arguments.length === 0 || node.arguments.some(ts.isSpreadElement)) return;
  if (isClientFile(sourceFile, context.checker)) return;
  if (target.library === 'fetch') {
    if (!isGlobalFetch(target.receiver, context) || isRequestObject(node.arguments[0], context)) return;
    if (isRootRelativeUrl(node.arguments[0], context.checker)) return;
  } else if (!isDefaultAxios(target.receiver, context) || sourceFile.text.includes('defaults.timeout')) {
    return;
  }
  const options = node.arguments[target.optionsIndex];
  if (options) {
    let literal = skipParentheses(options);
    if (ts.isIdentifier(literal)) literal = unchangedOptionsLiteral(literal, target.limitKeys, context.checker);
    if (!literal || !ts.isObjectLiteralExpression(literal) || !literalLacksLimit(literal, target.limitKeys)) return;
  }
  context.report(node, rule, message(target));
}

function isAwsSdkClient(node, context) {
  const declaration = context.checker.getResolvedSignature(node)?.declaration;
  const filename = declaration?.getSourceFile().fileName.replaceAll('\\', '/');
  return !!filename && filename.includes('/node_modules/@aws-sdk/client-');
}

function isPrivateMember(member) {
  return (
    ts.isPrivateIdentifier(member.name) ||
    !!member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)
  );
}

// Every use of the private field `this.<name>` within its class.
function privateFieldUses(classNode, name) {
  const member = classNode.members.find(
    (candidate) => ts.isPropertyDeclaration(candidate) && candidate.name.getText() === name,
  );
  if (!member || !isPrivateMember(member)) return;
  const uses = [];
  (function visit(node) {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.name.getText() === name
    )
      uses.push(node);
    ts.forEachChild(node, visit);
  })(classNode);
  return uses;
}

// Every use of a non-exported const in its file.
function constUses(declaration, checker) {
  const statement = declaration.parent.parent;
  if (!(declaration.parent.flags & ts.NodeFlags.Const) || !ts.isIdentifier(declaration.name)) return;
  if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return;
  const name = declaration.name.text;
  const uses = [];
  (function visit(node) {
    if (ts.isIdentifier(node) && node.text === name && node !== declaration.name) {
      const target = checker.getSymbolAtLocation(node)?.declarations?.[0];
      if (target?.pos === declaration.pos && target.getSourceFile() === declaration.getSourceFile()) uses.push(node);
    }
    ts.forEachChild(node, visit);
  })(declaration.getSourceFile());
  return uses;
}

// The uses of the variable or private field that holds this client, when every one of them is visible here.
function clientUses(node, checker) {
  let expression = node;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  const holder = expression.parent;
  if (ts.isVariableDeclaration(holder) && holder.initializer === expression) return constUses(holder, checker);
  const classNode = ts.findAncestor(holder, ts.isClassLike);
  if (!classNode) return;
  if (ts.isPropertyDeclaration(holder) && holder.initializer === expression) {
    return privateFieldUses(classNode, holder.name.getText());
  }
  if (
    ts.isBinaryExpression(holder) &&
    holder.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    holder.right === expression &&
    ts.isPropertyAccessExpression(holder.left) &&
    holder.left.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return privateFieldUses(classNode, holder.left.name.getText())?.filter((use) => use !== holder.left);
  }
}

// `client.send(command, { abortSignal })` sets its own deadline.
function isLimitedSend(use) {
  const access = use.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== use || access.name.text !== 'send') return false;
  const call = access.parent;
  if (!ts.isCallExpression(call) || call.expression !== access) return false;
  const options = call.arguments[1] && skipParentheses(call.arguments[1]);
  return (
    !!options &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.some((property) => propertyName(property) === 'abortSignal')
  );
}

// Uses that make no request: a presence check, or presigning a URL locally.
function isOfflineUse(use) {
  const parent = use.parent;
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isIfStatement(parent) && parent.expression === use) return true;
  return (
    ts.isCallExpression(parent) &&
    parent.arguments[0] === use &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === 'getSignedUrl'
  );
}

function everySendHasDeadline(node, checker) {
  const uses = clientUses(node, checker);
  if (!uses) return false;
  const sends = uses.filter(isLimitedSend);
  return sends.length > 0 && uses.every((use) => sends.includes(use) || isOfflineUse(use));
}

// AWS SDK v3 clients default to no request or connection timeout, so a hung endpoint holds the caller.
function checkAwsClient(node, context) {
  const callee = node.expression;
  const name = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : undefined;
  if (!name?.text.endsWith('Client') || isClientFile(node.getSourceFile(), context.checker)) return;
  const [config] = node.arguments ?? [];
  if (config) {
    const literal = skipParentheses(config);
    if (!ts.isObjectLiteralExpression(literal) || !literalLacksLimit(literal, ['requestHandler'])) return;
  }
  if (!isAwsSdkClient(node, context) || everySendHasDeadline(node, context.checker)) return;
  context.report(
    node,
    rule,
    `\`new ${name.text}()\` has no \`requestHandler\` timeouts, and AWS SDK v3 waits indefinitely by default, so a slow or hung endpoint holds every request that calls it and can exhaust the server's sockets. ` +
      'Pass `requestHandler: { requestTimeout: 30_000, connectionTimeout: 5_000 }` (pick limits that fit the largest expected transfer).',
  );
}

function message(target) {
  if (target.library === 'fetch') {
    return (
      '`fetch()` has no overall timeout (Node waits up to 5 minutes for response headers and again between body chunks, the undici defaults), ' +
      'so a slow or hung upstream holds this request (and its socket) for that long, and a few stuck upstream calls can exhaust the server. Pass `signal: AbortSignal.timeout(10_000)` ' +
      '(pick a limit that fits this API) and handle the resulting `TimeoutError`. Skip it only for streams that are meant to stay open.'
    );
  }
  return (
    '`axios` call has no timeout (axios waits forever by default), so a slow or hung upstream holds this request ' +
    '(and its socket) indefinitely, and a few stuck calls can exhaust the server. Pass `timeout: 10_000` ' +
    '(pick a limit that fits this API) or set it once with `axios.create({ timeout })`. Skip it only for long-lived streams.'
  );
}

module.exports = { check, checkAwsClient, describeCall, isDefaultAxios, isGlobalFetch, skipParentheses };
