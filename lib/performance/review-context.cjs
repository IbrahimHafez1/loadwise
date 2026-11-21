'use strict';

const { syntax: ts } = require('./compiler.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { privateProcessEntries } = require('./node-fs.cjs');
const { findRepeatOwner, isStandardArrayCall } = require('./repeated.cjs');
const { loopReviewReason } = require('./sequential-loops.cjs');

// `warden-reviewed` and `backend-perf-reviewed` are earlier names of the directive and stay accepted.
const reviewMarkers = ['loadwise-reviewed', 'warden-reviewed', 'backend-perf-reviewed'];
const directive =
  /^[\t ]*\/\/[\t ]+(?:loadwise|warden|backend-perf)-reviewed[\t ]+([a-z][a-z0-9-]*)[\t ]+--[\t ]+(\S[^\r\n]*?)[\t ]*$/;
const protectedRules = new Set([
  'pg-transaction-on-pool',
  'prisma-scope-unverified',
  'drizzle-scope-unverified',
  'prisma-transaction-client-escape',
  'typeorm-transaction-client-escape',
  'prisma-read-modify-write',
]);
const testWriteRules = new Set(['prisma-dependent-writes', 'drizzle-unfiltered-write']);

function reviewedReason(source, line, ruleId) {
  if (!line || protectedRules.has(ruleId)) return;
  const starts = source.getLineStarts();
  const previous = source.text.slice(starts[line - 1], starts[line]).trimEnd();
  const match = directive.exec(previous);
  if (!match || match[1] !== ruleId) return;
  // Template text, JSX, and a line inside a block comment can look like a directive.
  // Only a standalone line comment in the compiler's leading trivia is authoritative.
  const offset = starts[line - 1] + previous.indexOf('//');
  const token = ts.getTokenAtPosition(source, offset);
  if (
    ts
      .getLeadingCommentRanges(source.text, token.pos)
      ?.some((range) => range.pos === offset && range.kind === ts.SyntaxKind.SingleLineCommentTrivia)
  ) {
    return 'Reviewed in source: ' + match[2];
  }
}

function testWriteContext(file, ruleId) {
  if (!testWriteRules.has(ruleId)) return;
  if (/(?:^|[/\\])(?:__tests__|tests?)[/\\]|\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(file)) {
    return 'Write in a test source. Verify fixture setup or cleanup semantics.';
  }
}

function smallCatalogue(loop, checker) {
  let values = ts.skipOuterExpressions(loop.expression);
  if (ts.isIdentifier(values)) {
    let symbol = checker.getSymbolAtLocation(values);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const binding = symbol?.valueDeclaration;
    if (
      !binding ||
      !ts.isVariableDeclaration(binding) ||
      !binding.initializer ||
      !(binding.parent.flags & ts.NodeFlags.Const)
    )
      return false;
    values = ts.skipOuterExpressions(binding.initializer);
  }
  return (
    ts.isArrayLiteralExpression(values) &&
    values.elements.length <= 8 &&
    values.elements.every(ts.isObjectLiteralExpression)
  );
}

function waitsBetweenPolls(loop) {
  if (
    !ts.isBlock(loop.statement) ||
    !ts.isBinaryExpression(loop.condition) ||
    loop.condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
    !ts.isNumericLiteral(loop.condition.right)
  )
    return false;
  return loop.statement.statements.some((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) return false;
    const promise = statement.expression.expression;
    if (!ts.isNewExpression(promise) || !ts.isIdentifier(promise.expression) || promise.expression.text !== 'Promise')
      return false;
    const callback = promise.arguments?.[0];
    return (
      callback &&
      ts.isArrowFunction(callback) &&
      ts.isCallExpression(callback.body) &&
      ts.isIdentifier(callback.body.expression) &&
      callback.body.expression.text === 'setTimeout' &&
      callback.body.arguments.length >= 2 &&
      ts.isIdentifier(callback.body.arguments[0]) &&
      callback.body.arguments[0].text === callback.parameters[0]?.name.text
    );
  });
}

const lookupRules = new Set(['array-repeated-membership', 'array-repeated-find']);
const blockingRules = new Set([
  'node-sync-fs-in-async',
  'node-sync-crypto-in-async',
  'node-sync-compression-in-async',
  'node-sync-process-in-async',
  'password-hash-sync-in-async',
]);
const perItemQueryRules = new Set([
  'prisma-query-in-loop',
  'drizzle-query-in-loop',
  'pg-query-in-loop',
  'redis-command-in-loop',
  'pg-dynamic-query-text',
  'orm-query-in-loop',
  'service-query-in-loop',
]);
// Rules whose findings only matter on a request path, so tests, seeds and operator tooling are contextual.
const setupContextRules = new Set([
  'serial-awaits-in-literal',
  'redis-keys-command',
  'index-missing-order',
  'index-missing-filter',
  'password-hash-pure-js',
  'queue-add-in-loop',
  'typeorm-transaction-in-loop',
  'typeorm-unused-count',
  'prisma-count-for-existence',
  'external-call-in-transaction',
  'http-call-without-timeout',
  'await-before-early-exit',
  'find-then-create-race',
  'unbounded-list-query',
  'list-query-overfetch',
]);
// Per-item loop rules whose loops can be one-at-a-time on purpose; see loopReviewReason.
const loopRules = new Set([
  'orm-query-in-loop',
  'service-query-in-loop',
  'typeorm-transaction-in-loop',
  'queue-add-in-loop',
]);
// A suffix identifies a test anywhere. A directory name identifies one only inside the project, because the
// project itself may live under a test directory.
const testSourcePattern = /[.-]i?(?:spec|test)\.[cm]?[jt]sx?$/i;
const testDirectoryPattern = /(?:^|[/\\])(?:__tests__|tests?)[/\\]/i;
const clientSourcePattern = /\.[jt]sx$/i;
// Only unambiguous demo-data names: a bare "data" directory often holds production code.
const seedSourcePattern =
  /(?:^|[/\\])(?:seeds?|seeders?|rich-data|demo-data|sample-data)[/\\]|[.-]seed\.[cm]?[jt]sx?$|(?:^|[/\\])seed\.[cm]?[jt]sx?$/i;
const benchmarkSourcePattern = /(?:^|[/\\.-])bench(?:mark)?[.-][^/\\]*$|[/\\](?:bench|benchmarks)[/\\]/i;
const toolingDirectoryPattern =
  /(?:^|[/\\])(?:scripts?|deploy|migrations?|seeds?|seeders?|database[/\\]commands)[/\\]/i;
// A runnable script under a database folder, such as `database/run-backfill.ts` or `database/seed.cli.ts`.
const databaseScriptPattern = /(?:^|[/\\])database[/\\](?:[^/\\]+[/\\])*(?:run-[^/\\]+|[^/\\]+\.cli)\.[cm]?[jt]s$/i;
const projectRootMarkers = ['package.json', 'tsconfig.json', 'jsconfig.json', '.git'];

function createProjectRelativizer() {
  const roots = new Map();
  function projectRoot(directory) {
    if (!roots.has(directory)) {
      const parent = path.dirname(directory);
      let root;
      if (projectRootMarkers.some((name) => fs.existsSync(path.join(directory, name)))) root = directory;
      else if (parent !== directory) root = projectRoot(parent);
      roots.set(directory, root);
    }
    return roots.get(directory);
  }
  return (file) => {
    const absolute = path.resolve(file);
    const root = projectRoot(path.dirname(absolute));
    return root ? path.relative(root, absolute) : path.basename(absolute);
  };
}

const relativeToProject = createProjectRelativizer();

function isTestSource(file) {
  return testSourcePattern.test(file) || testDirectoryPattern.test(relativeToProject(file));
}

function isSeedSource(file) {
  return seedSourcePattern.test(relativeToProject(file));
}

// Operator tooling: a tooling folder, a database run script, or a standalone process entry point
// (a `require.main === module` guard, or a top-level `main()` that sets the exit status).
function isToolingSource(source) {
  const relative = relativeToProject(source.fileName);
  return (
    toolingDirectoryPattern.test(relative) ||
    databaseScriptPattern.test(relative) ||
    (privateProcessEntries(source).size > 0 && !exportsFromModule(source))
  );
}

// `module.exports = …`, `module.exports.name = …` or `exports.name = …`.
function isCommonJsExport(statement) {
  if (!ts.isExpressionStatement(statement)) return false;
  const assignment = statement.expression;
  if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const target = assignment.left.getText();
  return target === 'module.exports' || target.startsWith('module.exports.') || target.startsWith('exports.');
}

// A module that exports code is also imported by other code, so its entry point does not make it standalone tooling.
function exportsFromModule(source) {
  return source.statements.some(
    (statement) =>
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      isCommonJsExport(statement) ||
      ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export,
  );
}

function setupSourceContext(source) {
  const file = source.fileName;
  if (isTestSource(file)) return 'Runs in a test source rather than a request path.';
  if (isSeedSource(file)) return 'Runs in seed or demo-data setup rather than a request path.';
  if (isToolingSource(source))
    return 'Runs in operator tooling (scripts, standalone entry points, deployment, migrations or commands) rather than a request path.';
}

function perItemQueryContext(ruleId, source) {
  const file = source.fileName;
  const dynamicText = ruleId === 'pg-dynamic-query-text';
  const subject = dynamicText ? 'Dynamic SQL text' : 'A per-item query';
  const advice = dynamicText
    ? 'Review only if any part of the text can come from user input.'
    : 'Review only if the data set can grow large or setup time matters.';
  if (isTestSource(file)) return subject + ' in a test source rather than a request path. ' + advice;
  if (isSeedSource(file)) return subject + ' in seed or demo-data setup rather than a request path. ' + advice;
  if (benchmarkSourcePattern.test(file)) return subject + ' in a benchmark rather than a request path. ' + advice;
  if (isToolingSource(source))
    return (
      subject +
      ' in operator tooling (scripts, standalone entry points, deployment, migrations or commands) rather than a request path. ' +
      advice
    );
}

function sourceKindContext(node, ruleId, checker, source) {
  const file = source.fileName;
  if (perItemQueryRules.has(ruleId)) return perItemQueryContext(ruleId, source);
  if (setupContextRules.has(ruleId)) return setupSourceContext(source);
  if (lookupRules.has(ruleId)) {
    if (isTestSource(file)) return 'Lookup in a test source. Review only if the fixture can grow large.';
    if (clientSourcePattern.test(file))
      return 'Client UI render code rather than a server request path. Review in a front-end context.';
    if (isSeedSource(file))
      return 'Seed or demo-data setup runs outside request paths. Review if the data set can grow large.';
    return;
  }
  if (!blockingRules.has(ruleId)) return;
  if (isTestSource(file)) return 'Synchronous call in a test source rather than a request path.';
  if (isSeedSource(file)) return 'Synchronous call in seed or demo-data setup rather than a request path.';
  if (isToolingSource(source) && !findRepeatOwner(node, checker)) {
    return 'One synchronous call in operator tooling (scripts, deployment, migrations or commands). Prioritize if the server also imports this module.';
  }
}

function repeatedReviewContext(node, ruleId, checker, source) {
  return (
    specificReviewContext(node, ruleId, checker, source) ??
    sourceKindContext(node, ruleId, checker, source) ??
    loopShapeContext(node, ruleId, checker)
  );
}

function loopShapeContext(node, ruleId, checker) {
  if (!loopRules.has(ruleId)) return;
  const call = ts.findAncestor(node, ts.isCallExpression);
  return call && loopReviewReason(call, findRepeatOwner(call, checker), checker, ruleId);
}

function specificReviewContext(node, ruleId, checker, source) {
  if (
    ruleId === 'typeorm-existence-materialization' &&
    /[/\\](?:seeds?|seeders?)[/\\][^/\\]+$/i.test(source.fileName) &&
    privateProcessEntries(source).size &&
    !findRepeatOwner(node, checker)
  ) {
    return 'One existence check in a seed module with a standalone process entry. Prioritize if this path also runs during requests.';
  }
  if (ruleId !== 'array-repeated-membership' && ruleId !== 'orm-query-in-loop') return;
  const file = source.fileName;
  const fixture = /[.-](?:spec|test)\.[cm]?[jt]sx?$/i.test(file);
  if (ruleId === 'orm-query-in-loop' && (fixture || /[/\\](?:seeds?|seeders?)[/\\][^/\\]+$/i.test(file))) {
    const owner = findRepeatOwner(node, checker);
    if (owner && ts.isForOfStatement(owner) && !findRepeatOwner(owner, checker) && smallCatalogue(owner, checker))
      return 'The seed or test iterates a small literal catalogue. Review round trips if it grows or setup time matters.';
  }
  if (ruleId === 'array-repeated-membership' && fixture) {
    const owner = findRepeatOwner(node, checker);
    if (owner && ts.isForStatement(owner) && owner.condition && waitsBetweenPolls(owner))
      return 'This test polls with a timer between attempts. Compare lookup cost with the wait before allocating a Set.';
  }
  if (/(?:^|[/\\.-])bench(?:mark)?[.-][^/\\]*$|[/\\](?:bench|benchmarks)[/\\]/i.test(file)) {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!ts.isFunctionLike(parent)) continue;
      if (
        ts.isFunctionDeclaration(parent) &&
        parent.parent === source &&
        parent.name &&
        !parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
        privateProcessEntries(source).has(parent.name.text)
      )
        return 'This work runs in a standalone benchmark. Check measurement isolation and per-run dependencies before changing it.';
      const call = parent.parent;
      if (!ts.isCallExpression(call) || call.arguments[0] !== parent || !isStandardArrayCall(call, checker)) return;
    }
  }
}

function createTestWriteClassifier() {
  const relativize = createProjectRelativizer();
  return (file, ruleId) => {
    if (!testWriteRules.has(ruleId)) return;
    return testWriteContext(relativize(file), ruleId);
  };
}

module.exports = {
  reviewedReason,
  reviewMarkers,
  testWriteContext,
  createTestWriteClassifier,
  repeatedReviewContext,
  isTestSource,
  isSeedSource,
};
