'use strict';

// Rewrites a blocking `xSync(...)` call into its awaited counterpart, keeping the user's receiver and arguments.
// Every builder returns undefined whenever the shape is not provably equivalent, so the generic example is shown.
const { isBuiltin } = require('node:module');
const { ts, calleeCall, nameTaken } = require('./helpers.cjs');

const moduleSpecifierPrefix = /^node:/;
const syncSuffix = 'Sync';

// Methods whose promise form takes the same arguments and resolves to the same value as the sync form.
// Left out: existsSync (access has other semantics), fd based calls (promises use FileHandle), globSync (iterator).
const fsMethods = new Set([
  'accessSync',
  'appendFileSync',
  'chmodSync',
  'chownSync',
  'copyFileSync',
  'cpSync',
  'linkSync',
  'lstatSync',
  'lutimesSync',
  'mkdirSync',
  'mkdtempSync',
  'readdirSync',
  'readFileSync',
  'readlinkSync',
  'realpathSync',
  'renameSync',
  'rmdirSync',
  'rmSync',
  'statfsSync',
  'statSync',
  'symlinkSync',
  'truncateSync',
  'unlinkSync',
  'utimesSync',
  'writeFileSync',
]);
// The promise form of these has no `throwIfNoEntry` option, so any options argument may change behavior.
const fsMethodsWithoutOptions = new Set(['statSync', 'lstatSync', 'statfsSync']);
const compressionMethods = new Set([
  'brotliCompressSync',
  'brotliDecompressSync',
  'deflateRawSync',
  'deflateSync',
  'gunzipSync',
  'gzipSync',
  'inflateRawSync',
  'inflateSync',
  'unzipSync',
  'zstdCompressSync',
  'zstdDecompressSync',
]);
const cryptoMethods = new Set(['argon2Sync', 'generateKeyPairSync', 'pbkdf2Sync', 'scryptSync']);
const bcryptMethods = new Map([
  ['hashSync', 'hash'],
  ['compareSync', 'compare'],
  ['genSaltSync', 'genSalt'],
]);
const bcryptModules = new Set(['bcrypt', 'bcryptjs']);
const childProcessMethods = new Map([
  ['execSync', 'exec'],
  ['execFileSync', 'execFile'],
]);
// Options that behave the same for the sync and the promisified call.
const portableProcessOptions = new Set(['cwd', 'env', 'timeout']);

function moduleNameOf(specifier) {
  if (!specifier || !ts.isStringLiteralLike(specifier)) return;
  return specifier.text.replace(moduleSpecifierPrefix, '');
}

function requiredModuleName(initializer) {
  if (!initializer || !ts.isCallExpression(initializer)) return;
  const { expression, arguments: args } = initializer;
  if (!ts.isIdentifier(expression) || expression.text !== 'require' || args.length !== 1) return;
  return moduleNameOf(args[0]);
}

function bindingsOfImport(statement, localName) {
  const moduleName = moduleNameOf(statement.moduleSpecifier);
  const clause = statement.importClause;
  if (!moduleName || !clause || clause.isTypeOnly) return;
  if (clause.name?.text === localName) return { moduleName, kind: 'namespace' };
  const { namedBindings } = clause;
  if (!namedBindings) return;
  if (ts.isNamespaceImport(namedBindings)) {
    return namedBindings.name.text === localName ? { moduleName, kind: 'namespace' } : undefined;
  }
  for (const element of namedBindings.elements) {
    if (element.name.text !== localName || element.isTypeOnly) continue;
    const importedName = (element.propertyName ?? element.name).text;
    return importedName === 'default' ? { moduleName, kind: 'namespace' } : { moduleName, kind: 'named', importedName };
  }
}

function bindingsOfRequire(statement, localName) {
  if (!(statement.declarationList.flags & ts.NodeFlags.Const)) return;
  for (const declaration of statement.declarationList.declarations) {
    const moduleName = requiredModuleName(declaration.initializer);
    if (!moduleName) continue;
    if (ts.isIdentifier(declaration.name) && declaration.name.text === localName)
      return { moduleName, kind: 'namespace' };
    if (!ts.isObjectBindingPattern(declaration.name)) continue;
    for (const element of declaration.name.elements) {
      if (element.dotDotDotToken || element.initializer || !ts.isIdentifier(element.name)) continue;
      if (element.name.text !== localName) continue;
      const key = element.propertyName ?? element.name;
      if (ts.isIdentifier(key)) return { moduleName, kind: 'named', importedName: key.text };
    }
  }
}

// What a top-level import or require binds `localName` to: the whole module, or one named export of it.
function resolveBinding(sourceFile, localName) {
  for (const statement of sourceFile.statements) {
    let binding;
    if (ts.isImportDeclaration(statement)) binding = bindingsOfImport(statement, localName);
    else if (ts.isVariableStatement(statement)) binding = bindingsOfRequire(statement, localName);
    else if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.name.text === localName &&
      ts.isExternalModuleReference(statement.moduleReference)
    ) {
      const moduleName = moduleNameOf(statement.moduleReference.expression);
      if (moduleName) binding = { moduleName, kind: 'namespace' };
    }
    if (binding) return binding;
  }
}

// The user's callee as `{ receiver, binding, method }`: `fs.readFileSync` or a named import such as `readFileSync`.
function describeCallee(call, sourceFile) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    const binding = resolveBinding(sourceFile, callee.text);
    if (binding?.kind !== 'named') return;
    return { binding, method: binding.importedName };
  }
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken || !ts.isIdentifier(callee.expression)) return;
  const binding = resolveBinding(sourceFile, callee.expression.text);
  if (binding?.kind !== 'namespace') return;
  return { receiver: callee.expression.text, binding, method: callee.name.text };
}

// The nearest function must be async and own the call in its body; parameters, fields and sync callbacks cannot await.
function awaitable(call) {
  for (let parent = call.parent, child = call; parent; child = parent, parent = parent.parent) {
    if (ts.isPropertyDeclaration(parent) || ts.isClassStaticBlockDeclaration(parent) || ts.isDecorator(parent))
      return false;
    if (!ts.isFunctionLike(parent)) continue;
    const isAsync = parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
    return Boolean(isAsync) && parent.body === child;
  }
  return false;
}

function candidateCall(node) {
  const call = calleeCall(node);
  if (!call || call.typeArguments || call.questionDotToken || !awaitable(call)) return;
  if (call.parent && ts.isAwaitExpression(call.parent)) return;
  return call;
}

// `await` binds looser than member access, calls and `**`, so those parents need the awaited value wrapped.
function needsParentheses(call) {
  const { parent } = call;
  if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) return parent.expression === call;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return parent.expression === call;
  if (ts.isTaggedTemplateExpression(parent)) return parent.tag === call;
  if (ts.isNonNullExpression(parent)) return true;
  return (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken &&
    parent.left === call
  );
}

// Replaces only the callee, so the arguments keep the user's formatting.
function awaitedCallEdits(call, newCalleeText) {
  const callee = call.expression;
  const wrap = needsParentheses(call);
  const edits = [
    {
      start: callee.getStart(call.getSourceFile()),
      end: callee.end,
      text: (wrap ? '(await ' : 'await ') + newCalleeText,
    },
  ];
  if (wrap) edits.push({ start: call.end, end: call.end, text: ')' });
  return edits;
}

// Notes telling the user which import the rewrite needs; undefined when the local name is already taken by something else.
function importNotes(sourceFile, localName, moduleName, importedName = localName) {
  const binding = resolveBinding(sourceFile, localName);
  if (binding) {
    const sameExport =
      binding.moduleName === moduleName && binding.kind === 'named' && binding.importedName === importedName;
    return sameExport ? [] : undefined;
  }
  if (nameTaken(sourceFile, localName)) return;
  const specifier = isBuiltin(moduleName) ? `node:${moduleName}` : moduleName;
  return [`Import \`${importedName}\` from '${specifier}'.`];
}

function result(edits, notes) {
  return { edits, ...(notes.length && { note: notes.join(' ') }) };
}

function fdLike(argument) {
  if (!argument) return false;
  if (ts.isNumericLiteral(argument)) return true;
  return ts.isIdentifier(argument) && /fd$/i.test(argument.text);
}

function fixFs({ node, sourceFile }) {
  const call = candidateCall(node);
  const callee = call && describeCallee(call, sourceFile);
  if (!callee || callee.binding.moduleName !== 'fs' || !fsMethods.has(callee.method)) return;
  if (fdLike(call.arguments[0]) || call.arguments.some(ts.isSpreadElement)) return;
  if (fsMethodsWithoutOptions.has(callee.method) && call.arguments.length > 1) return;
  const promiseName = callee.method.slice(0, -syncSuffix.length);
  if (callee.receiver) return result(awaitedCallEdits(call, `${callee.receiver}.promises.${promiseName}`), []);
  const notes = importNotes(sourceFile, promiseName, 'fs/promises');
  if (!notes) return;
  return result(awaitedCallEdits(call, promiseName), notes);
}

function promisifiedCall(call, callee, callbackName, moduleName, sourceFile) {
  const promisifyNotes = importNotes(sourceFile, 'promisify', 'util');
  if (!promisifyNotes) return;
  if (callee.receiver) {
    return result(awaitedCallEdits(call, `promisify(${callee.receiver}.${callbackName})`), promisifyNotes);
  }
  const callbackNotes = importNotes(sourceFile, callbackName, moduleName);
  if (!callbackNotes) return;
  return result(awaitedCallEdits(call, `promisify(${callbackName})`), [...callbackNotes, ...promisifyNotes]);
}

function callbackFormFix(moduleName, methods) {
  return ({ node, sourceFile }) => {
    const call = candidateCall(node);
    const callee = call && describeCallee(call, sourceFile);
    if (!callee || callee.binding.moduleName !== moduleName || !methods.has(callee.method)) return;
    if (call.arguments.some(ts.isSpreadElement)) return;
    const callbackName = callee.method.slice(0, -syncSuffix.length);
    return promisifiedCall(call, callee, callbackName, moduleName, sourceFile);
  };
}

function isPortableProcessOptions(argument) {
  if (!ts.isObjectLiteralExpression(argument)) return false;
  return argument.properties.every(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      ts.isIdentifier(property.name) &&
      portableProcessOptions.has(property.name.text),
  );
}

// execSync returns the output while the promisified exec resolves to { stdout, stderr }, so only a call whose
// result is discarded, with options both forms treat alike, is rewritten.
function hasPortableProcessArguments(call, method) {
  const args = [...call.arguments];
  if (args.some(ts.isSpreadElement) || args.length === 0) return false;
  const last = args.at(-1);
  if (ts.isObjectLiteralExpression(last)) return isPortableProcessOptions(last);
  if (method === 'execSync') return args.length === 1;
  return args.length === 1 || (args.length === 2 && ts.isArrayLiteralExpression(last));
}

function fixChildProcess({ node, sourceFile }) {
  const call = candidateCall(node);
  const callee = call && describeCallee(call, sourceFile);
  if (!callee || callee.binding.moduleName !== 'child_process') return;
  const callbackName = childProcessMethods.get(callee.method);
  if (!callbackName || !ts.isExpressionStatement(call.parent)) return;
  if (!hasPortableProcessArguments(call, callee.method)) return;
  const promisified = promisifiedCall(call, callee, callbackName, 'child_process', sourceFile);
  if (!promisified) return;
  return {
    ...promisified,
    note: [promisified.note, 'Output is no longer forwarded to the parent stderr.'].filter(Boolean).join(' '),
  };
}

function fixBcrypt({ node, sourceFile }) {
  const call = candidateCall(node);
  const callee = call && describeCallee(call, sourceFile);
  const promiseName = callee && bcryptMethods.get(callee.method);
  if (!promiseName || !bcryptModules.has(callee.binding.moduleName)) return;
  if (call.arguments.some(ts.isSpreadElement)) return;
  if (callee.receiver) return result(awaitedCallEdits(call, `${callee.receiver}.${promiseName}`), []);
  const notes = importNotes(sourceFile, promiseName, callee.binding.moduleName);
  if (!notes) return;
  return result(awaitedCallEdits(call, promiseName), notes);
}

module.exports = {
  'node-sync-fs-in-async': fixFs,
  'node-sync-compression-in-async': callbackFormFix('zlib', compressionMethods),
  'node-sync-crypto-in-async': callbackFormFix('crypto', cryptoMethods),
  'node-sync-process-in-async': fixChildProcess,
  'password-hash-sync-in-async': fixBcrypt,
};
