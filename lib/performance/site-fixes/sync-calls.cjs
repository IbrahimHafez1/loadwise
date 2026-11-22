'use strict';

// Rewrites a blocking `xSync(...)` call into its awaited counterpart, keeping the user's receiver and arguments.
// Every builder returns undefined whenever the shape is not provably equivalent, so the generic example is shown.
const { isBuiltin } = require('node:module');
const { requireReview, ts, calleeCall, nameTaken } = require('./helpers.cjs');

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
    if (binding) return { ...binding, statement };
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
  return call && awaitableCall(call) ? call : undefined;
}

function awaitableCall(call) {
  if (call.typeArguments || call.questionDotToken || !awaitable(call)) return false;
  return !(call.parent && ts.isAwaitExpression(call.parent));
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

// The import the rewrite needs as `[{ moduleName, importedName }]`: empty when the file already imports it, undefined
// when the local name is taken by something else.
function neededImports(sourceFile, localName, moduleName, importedName = localName) {
  const binding = resolveBinding(sourceFile, localName);
  if (binding) {
    const sameExport =
      binding.moduleName === moduleName && binding.kind === 'named' && binding.importedName === importedName;
    return sameExport ? [] : undefined;
  }
  if (nameTaken(sourceFile, localName)) return;
  return [{ moduleName, importedName }];
}

// Notes telling the user which import the rewrite needs; undefined when the local name is already taken by something else.
function importNotes(sourceFile, localName, moduleName, importedName = localName) {
  return neededImports(sourceFile, localName, moduleName, importedName)?.map((needed) => {
    const specifier = isBuiltin(needed.moduleName) ? `node:${needed.moduleName}` : needed.moduleName;
    return `Import \`${needed.importedName}\` from '${specifier}'.`;
  });
}

function result(edits, notes) {
  return { edits, ...(notes.length && { note: notes.join(' ') }) };
}

function fdLike(argument) {
  if (!argument) return false;
  if (ts.isNumericLiteral(argument)) return true;
  return ts.isIdentifier(argument) && /fd$/i.test(argument.text);
}

// A rewrite is `{ callEdits, imports, anchor, swappedName, note }`: `imports` lists what the new call needs imported,
// `anchor` is the statement that imports the sync callee, and `swappedName` marks a named fs import that can be swapped.
function fsRewrite(call, sourceFile) {
  const callee = describeCallee(call, sourceFile);
  if (!callee || callee.binding.moduleName !== 'fs' || !fsMethods.has(callee.method)) return;
  if (fdLike(call.arguments[0]) || call.arguments.some(ts.isSpreadElement)) return;
  if (fsMethodsWithoutOptions.has(callee.method) && call.arguments.length > 1) return;
  const promiseName = callee.method.slice(0, -syncSuffix.length);
  if (callee.receiver)
    return { callEdits: awaitedCallEdits(call, `${callee.receiver}.promises.${promiseName}`), imports: [] };
  const imports = neededImports(sourceFile, promiseName, 'fs/promises');
  if (!imports) return;
  return {
    callEdits: awaitedCallEdits(call, promiseName),
    imports,
    anchor: callee.binding.statement,
    swappedName: promiseName,
  };
}

// Every fix carries its own import edit, so it compiles when applied alone. A file with one rewritable call swaps the
// sync import for the promise one; with several, each fix adds the same import lines covering all of them, so fixes
// applied together share that one change instead of editing the import line in conflicting ways.
function fixWithImports(rewriteCall) {
  return ({ node, sourceFile }) => {
    const call = candidateCall(node);
    const rewrite = call && rewriteCall(call, sourceFile);
    if (!rewrite) return;
    const notes = rewrite.note ? [rewrite.note] : [];
    const plan = importPlan(sourceFile);
    if (rewrite.swappedName && plan.siteCount === 1) {
      const needsImport = rewrite.imports.length > 0;
      const swapped = swappedImportEdits(sourceFile, call.expression, rewrite.swappedName, needsImport);
      if (swapped) return result([...rewrite.callEdits, ...swapped], notes);
    }
    if (!rewrite.imports.length) return result(rewrite.callEdits, notes);
    return {
      ...result([...rewrite.callEdits, plan.importEdit], notes),
      ...(plan.siteCount > 1 && { separateEdits: true }),
    };
  };
}

const importPlans = new WeakMap();
function importPlan(sourceFile) {
  if (!importPlans.has(sourceFile)) importPlans.set(sourceFile, buildImportPlan(sourceFile));
  return importPlans.get(sourceFile);
}

// The number of rewritable sync calls in the file, and one insertion after the earliest statement importing one of
// their callees that imports everything their rewrites need.
function buildImportPlan(sourceFile) {
  const rewrites = [];
  (function visit(node) {
    if (ts.isCallExpression(node) && awaitableCall(node)) {
      const rewrite = rewriteKinds.map((rewriteCall) => rewriteCall(node, sourceFile)).find(Boolean);
      if (rewrite) rewrites.push(rewrite);
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  const importing = rewrites.filter((rewrite) => rewrite.imports.length);
  if (!importing.length) return { siteCount: rewrites.length };
  const anchor = importing.map((rewrite) => rewrite.anchor).sort((left, right) => left.pos - right.pos)[0];
  const namesByModule = new Map();
  for (const { moduleName, importedName } of importing.flatMap((rewrite) => rewrite.imports)) {
    if (!namesByModule.has(moduleName)) namesByModule.set(moduleName, new Set());
    namesByModule.get(moduleName).add(importedName);
  }
  return { siteCount: rewrites.length, importEdit: importLinesEdit(sourceFile, anchor, namesByModule) };
}

function moduleSpecifierOf(statement) {
  if (ts.isImportDeclaration(statement)) return statement.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(statement)) return statement.moduleReference.expression;
  return statement.declarationList.declarations.find((declaration) => requiredModuleName(declaration.initializer))
    .initializer.arguments[0];
}

function semicolonOf(text, statement, sourceFile) {
  return text.slice(statement.getStart(sourceFile), statement.end).trimEnd().endsWith(';') ? ';' : '';
}

// Inserts `lines` after `statement`, each on its own line with the statement's indentation.
function linesAfter(text, statement, sourceFile, lines) {
  const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
  const statementStart = statement.getStart(sourceFile);
  const indentation = /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', statementStart - 1) + 1))[0];
  const inserted = lines.map((line) => lineBreak + indentation + line).join('');
  return { start: statement.end, end: statement.end, text: inserted };
}

// One import line per module, written the way `anchor` imports its module (`import` or `require`, `node:`, quotes).
function importLinesEdit(sourceFile, anchor, namesByModule) {
  const text = sourceFile.text;
  const specifier = moduleSpecifierOf(anchor);
  const quote = text[specifier.getStart(sourceFile)];
  const prefix = specifier.text.startsWith('node:') ? 'node:' : '';
  const semicolon = semicolonOf(text, anchor, sourceFile);
  const lines = [...namesByModule].map(([moduleName, names]) => {
    const quoted = `${quote}${prefix}${moduleName}${quote}`;
    const list = [...names].join(', ');
    return ts.isVariableStatement(anchor)
      ? `const { ${list} } = require(${quoted})${semicolon}`
      : `import { ${list} } from ${quoted}${semicolon}`;
  });
  return linesAfter(text, anchor, sourceFile, lines);
}

// Whether `name` appears anywhere besides the `skipped` identifiers, not counting member and key names.
function usedElsewhere(sourceFile, name, skipped) {
  let used = false;
  (function visit(node) {
    if (used) return;
    if (ts.isIdentifier(node) && node.text === name && !skipped.includes(node)) {
      const { parent } = node;
      const isMember = (ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) && parent.name === node;
      const isKey =
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        ((ts.isBindingElement(parent) || ts.isImportSpecifier(parent)) && parent.propertyName === node);
      if (!isMember && !isKey) used = true;
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  return used;
}

// The import specifier or require binding element that declares `localName`, with its list and statement.
function bindingDeclaration(sourceFile, localName) {
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const element = bindings.elements.find((candidate) => candidate.name.text === localName);
      if (element) return { statement, element, elements: bindings.elements, specifier: statement.moduleSpecifier };
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isObjectBindingPattern(declaration.name) || !requiredModuleName(declaration.initializer)) continue;
        const element = declaration.name.elements.find(
          (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === localName,
        );
        if (!element) continue;
        if (statement.declarationList.declarations.length !== 1) return;
        return {
          statement,
          element,
          elements: declaration.name.elements,
          specifier: declaration.initializer.arguments[0],
        };
      }
    }
  }
}

// Once the call no longer uses the sync import, drop it (or its whole statement) and import the promise name from
// `fs/promises` beside it, written the way the file already imports `fs`. Undefined keeps the import and the note.
function swappedImportEdits(sourceFile, calleeName, promiseName, needsImport) {
  const localName = calleeName.text;
  const found = bindingDeclaration(sourceFile, localName);
  if (!found || usedElsewhere(sourceFile, localName, [calleeName, found.element.name])) return;
  const { statement, element, elements, specifier } = found;
  const text = sourceFile.text;
  const quote = text[specifier.getStart(sourceFile)];
  const promisesModule = `${quote}${specifier.text}/promises${quote}`;
  const semicolon = semicolonOf(text, statement, sourceFile);
  const added = ts.isImportDeclaration(statement)
    ? `import { ${promiseName} } from ${promisesModule}${semicolon}`
    : `const { ${promiseName} } = require(${promisesModule})${semicolon}`;
  const statementStart = statement.getStart(sourceFile);
  const clause = statement.importClause;
  if (elements.length === 1 && !clause?.name) {
    const replaced = { start: statementStart, end: statement.end, text: needsImport ? added : '' };
    return [needsImport ? replaced : wholeLine(text, replaced)];
  }
  const index = elements.indexOf(element);
  let removal;
  if (elements.length === 1) removal = { start: clause.name.end, end: clause.namedBindings.end, text: '' };
  else if (index < elements.length - 1)
    removal = { start: element.getStart(sourceFile), end: elements[index + 1].getStart(sourceFile), text: '' };
  else removal = { start: elements[index - 1].end, end: element.end, text: '' };
  if (!needsImport) return [removal];
  return [removal, linesAfter(text, statement, sourceFile, [added])];
}

// Widens a statement removal to its whole line when nothing else shares the line.
function wholeLine(text, edit) {
  const lineBegin = text.lastIndexOf('\n', edit.start - 1) + 1;
  const nextBreak = text.indexOf('\n', edit.end);
  const lineFinish = nextBreak === -1 ? text.length : nextBreak + 1;
  if (text.slice(lineBegin, edit.start).trim() || text.slice(edit.end, lineFinish).trim()) return edit;
  return { start: lineBegin, end: lineFinish, text: '' };
}

function promisifiedRewrite(call, callee, callbackName, moduleName, sourceFile) {
  const promisifyImports = neededImports(sourceFile, 'promisify', 'util');
  if (!promisifyImports) return;
  const anchor = callee.binding.statement;
  if (callee.receiver) {
    const callEdits = awaitedCallEdits(call, `promisify(${callee.receiver}.${callbackName})`);
    return { callEdits, imports: promisifyImports, anchor };
  }
  const callbackImports = neededImports(sourceFile, callbackName, moduleName);
  if (!callbackImports) return;
  const callEdits = awaitedCallEdits(call, `promisify(${callbackName})`);
  return { callEdits, imports: [...callbackImports, ...promisifyImports], anchor };
}

function callbackFormRewrite(moduleName, methods) {
  return (call, sourceFile) => {
    const callee = describeCallee(call, sourceFile);
    if (!callee || callee.binding.moduleName !== moduleName || !methods.has(callee.method)) return;
    if (call.arguments.some(ts.isSpreadElement)) return;
    const callbackName = callee.method.slice(0, -syncSuffix.length);
    return promisifiedRewrite(call, callee, callbackName, moduleName, sourceFile);
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

function childProcessRewrite(call, sourceFile) {
  const callee = describeCallee(call, sourceFile);
  if (!callee || callee.binding.moduleName !== 'child_process') return;
  const callbackName = childProcessMethods.get(callee.method);
  if (!callbackName || !ts.isExpressionStatement(call.parent)) return;
  if (!hasPortableProcessArguments(call, callee.method)) return;
  const promisified = promisifiedRewrite(call, callee, callbackName, 'child_process', sourceFile);
  return promisified && { ...promisified, note: 'Output is no longer forwarded to the parent stderr.' };
}

function fixBcrypt({ node, sourceFile }) {
  const call = candidateCall(node) ?? mapCallbackCall(node);
  const callee = call && describeCallee(call, sourceFile);
  const promiseName = callee && bcryptMethods.get(callee.method);
  if (!promiseName || !bcryptModules.has(callee.binding.moduleName)) return;
  if (call.arguments.some(ts.isSpreadElement)) return;
  const mapEdits = awaitable(call) ? [] : asyncMapEdits(call);
  if (!mapEdits) return;
  const mapNote = mapEdits.length
    ? ['The map callback becomes async under `Promise.all`, so the hashes run in parallel and keep their order.']
    : [];
  if (callee.receiver)
    return result([...mapEdits, ...awaitedCallEdits(call, `${callee.receiver}.${promiseName}`)], mapNote);
  const notes = importNotes(sourceFile, promiseName, callee.binding.moduleName);
  if (!notes) return;
  return result([...mapEdits, ...awaitedCallEdits(call, promiseName)], [...notes, ...mapNote]);
}

// A sync call directly inside a sync `.map(...)` callback that an async function runs.
function mapCallbackCall(node) {
  const call = calleeCall(node);
  if (!call || call.typeArguments || call.questionDotToken || ts.isAwaitExpression(call.parent)) return;
  const callback = mapCallbackOf(call);
  return callback && call;
}

function mapCallbackOf(call) {
  let callback = call.parent;
  while (callback && !ts.isFunctionLike(callback)) callback = callback.parent;
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return;
  // `await` is not allowed in parameter defaults.
  if (call.pos < callback.body.pos) return;
  if (callback.asteriskToken || callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
    return;
  const mapCall = callback.parent;
  if (!ts.isCallExpression(mapCall) || mapCall.arguments[0] !== callback || ts.isOptionalChain(mapCall)) return;
  if (!ts.isPropertyAccessExpression(mapCall.expression) || mapCall.expression.name.text !== 'map') return;
  if (ts.isAwaitExpression(mapCall.parent) || !awaitable(mapCall)) return;
  return callback;
}

// Code that runs after an await inside the callback interleaves with the other elements, so only side-effect free
// code may follow the call.
function hasEffectsAfter(callback, call) {
  let found = false;
  (function visit(current) {
    if (found) return;
    if (current.pos >= call.end && hasEffect(current)) found = true;
    else ts.forEachChild(current, visit);
  })(callback.body);
  return found;
}

function hasEffect(node) {
  if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) return true;
  if (ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isDeleteExpression(node)) return true;
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken;
  }
  if (!ts.isBinaryExpression(node)) return false;
  const operator = node.operatorToken.kind;
  return operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
}

// `list.map((item) => ...)` becomes `await Promise.all(list.map(async (item) => ...))`.
function asyncMapEdits(call) {
  const callback = mapCallbackOf(call);
  if (!callback || hasEffectsAfter(callback, call)) return;
  const mapCall = callback.parent;
  const sourceFile = call.getSourceFile();
  const wrap = needsParentheses(mapCall);
  const mapStart = mapCall.getStart(sourceFile);
  const callbackStart = callback.getStart(sourceFile);
  return [
    { start: mapStart, end: mapStart, text: (wrap ? '(' : '') + 'await Promise.all(' },
    { start: callbackStart, end: callbackStart, text: 'async ' },
    { start: mapCall.end, end: mapCall.end, text: wrap ? '))' : ')' },
  ];
}

const compressionRewrite = callbackFormRewrite('zlib', compressionMethods);
const cryptoRewrite = callbackFormRewrite('crypto', cryptoMethods);
// Text asyncMapEdits inserts to run a map callback's calls concurrently.
const concurrentMapMarker = 'await Promise.all(';
// The rewrites whose imports one file-wide plan covers.
const rewriteKinds = [fsRewrite, compressionRewrite, cryptoRewrite, childProcessRewrite];

module.exports = {
  'node-sync-fs-in-async': requireReview(
    'File operations in a map callback now run concurrently, so their order and error timing change.',
    fixWithImports(fsRewrite),
    (fix) => fix.edits.some(({ text }) => text.includes(concurrentMapMarker)),
  ),
  'node-sync-compression-in-async': fixWithImports(compressionRewrite),
  'node-sync-crypto-in-async': fixWithImports(cryptoRewrite),
  'node-sync-process-in-async': requireReview(
    'The child process no longer shares the parent stdio and its failure surfaces as a rejection.',
    fixWithImports(childProcessRewrite),
  ),
  'password-hash-sync-in-async': fixBcrypt,
};
