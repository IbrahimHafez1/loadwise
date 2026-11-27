import { ts } from './compiler.js';
import path from 'node:path';
import { classifyExecutionContext, workspaceScopedPath } from '../shared/execution-context.js';
import { isTempRoot, safeExists } from '../shared/project-root.js';
import { privateProcessEntries } from './node-fs.js';
import { rootRelativePath } from './node-fs-context.js';
import { findRepeatOwner, isStandardArrayCall } from './repeated.js';
import { loopReviewReason } from './sequential-loops.js';
import type { ForOfStatement, ForStatement, Node, SourceFile, Statement } from 'typescript';
import type { CheckerAdapter } from '../shared/types.js';

const reviewMarkers = ['loadwise-reviewed'];
const directive = /^[\t ]*\/\/[\t ]+loadwise-reviewed[\t ]+([a-z][a-z0-9-]*)[\t ]+--[\t ]+(\S[^\r\n]*?)[\t ]*$/;
const protectedRules = new Set([
  'pg-transaction-on-pool',
  'prisma-scope-unverified',
  'drizzle-scope-unverified',
  'prisma-transaction-client-escape',
  'typeorm-transaction-client-escape',
  'prisma-read-modify-write',
]);
const testWriteRules = new Set(['prisma-dependent-writes', 'drizzle-unfiltered-write']);

function reviewedReason(source: SourceFile, line: number, ruleId: string): string | undefined {
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

function testWriteContext(file: string, ruleId: string): string | undefined {
  if (!testWriteRules.has(ruleId)) return;
  if (/(?:^|[/\\])(?:__tests__|tests?)[/\\]|\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(file)) {
    return 'Write in a test source. Verify fixture setup or cleanup semantics.';
  }
}

function smallCatalogue(loop: ForOfStatement, checker: CheckerAdapter): boolean {
  let values = ts.skipOuterExpressions(loop.expression);
  if (ts.isIdentifier(values)) {
    let symbol = checker.getSymbolAtLocation(values);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
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

function waitsBetweenPolls(loop: ForStatement): boolean {
  if (
    !ts.isBlock(loop.statement) ||
    !loop.condition ||
    !ts.isBinaryExpression(loop.condition) ||
    loop.condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
    !ts.isNumericLiteral(loop.condition.right)
  )
    return false;
  return loop.statement.statements.some((statement: Statement) => {
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
      callback.parameters[0] !== undefined &&
      ts.isIdentifier(callback.parameters[0].name) &&
      callback.body.arguments[0].text === callback.parameters[0].name.text
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
// Rules whose findings only matter on a request path, so tests, seeds and operator tooling are
// contextual.
const setupContextRules = new Set([
  'serial-awaits-in-literal',
  'redis-keys-command',
  'index-missing-order',
  'index-missing-filter',
  'password-hash-pure-js',
  'queue-add-in-loop',
  'typeorm-transaction-in-loop',
  'typeorm-unused-count',
  'repeated-workbook-decode',
  'prisma-count-for-existence',
  'external-call-in-transaction',
  'http-call-without-timeout',
  'await-before-early-exit',
  'find-then-create-race',
  'unbounded-list-query',
  'list-query-overfetch',
  'orm-deep-offset',
  'list-count-per-request',
  'stream-pipe-unhandled-error',
  'orm-count-materialization',
  'session-memory-store',
  'whole-payload-in-memory',
]);
// Per-item loop rules whose loops can be one-at-a-time on purpose; see loopReviewReason.
const loopRules = new Set([
  'orm-query-in-loop',
  'service-query-in-loop',
  'typeorm-transaction-in-loop',
  'queue-add-in-loop',
]);
// A suffix identifies a test anywhere. A directory name identifies one only inside the project,
// because the project itself may live under a test directory.
const testSourcePattern =
  /[.-]i?(?:spec|test|e2e(?:-ee|-spec)?)\.[cm]?[jt]sx?$|(?:^|[/\\])(?:vitest\.[^/\\]+\.setup|jest\.setup)\.[cm]?[jt]sx?$/i;
const testDirectoryPattern =
  /(?:^|[/\\])(?:__tests__|tests?|e2e|[\w-]*test-utils|sandbox|__stories__|[\w-]*evals?|evaluations?|playwright|quality[/\\](?:testing|environments))[/\\]/i;
const clientSourcePattern = /\.[jt]sx$/i;
// Only unambiguous demo-data names: a bare "data" directory often holds production code.
const seedSourcePattern =
  /(?:^|[/\\])(?:seeds?|seeders?|rich-data|demo-data|sample-data)[/\\]|[.-]seed\.[cm]?[jt]sx?$|(?:^|[/\\])seed\.[cm]?[jt]sx?$/i;
const benchmarkSourcePattern = /(?:^|[/\\.-])bench(?:mark)?[.-][^/\\]*$|[/\\](?:bench|benchmarks)[/\\]/i;
const toolingDirectoryPattern =
  /(?:^|[/\\])(?:scripts?|deploy|migrations?|seeds?|seeders?|database[/\\]commands)[/\\]/i;
// A runnable script under a database folder, such as `database/run-backfill.ts` or
// `database/seed.cli.ts`.
const databaseScriptPattern = /(?:^|[/\\])database[/\\](?:[^/\\]+[/\\])*(?:run-[^/\\]+|[^/\\]+\.cli)\.[cm]?[jt]s$/i;
// Blocking calls in these places run at build time, at boot, in container or codemod tooling or in
// test support, even inside a loop. The path is taken from the repository root, because a tooling
// folder often has its own package.json.
const blockingToolingDirectoryPattern = /(?:^|\/)(?:docker|tools?|codemods?|startup|migrations?|tests?-[\w-]+|rsn)\//i;
const buildConfigPattern = /[.-]config\.[cm]?[jt]s$/i;
// Folders holding operator or container tooling, matched from the repository root.
const lookupToolingDirectoryPattern = /(?:^|\/)(?:docker|tools?|scripts?)\//i;
const projectRootMarkers = ['package.json', 'tsconfig.json', 'jsconfig.json', '.git'];

function createProjectRelativizer() {
  const roots = new Map<string, string | undefined>();
  const relatives = new Map<string, string>();
  function projectRoot(directory: string): string | undefined {
    if (!roots.has(directory)) {
      const parent = path.dirname(directory);
      let root: string | undefined;
      if (projectRootMarkers.some((name) => safeExists(path.join(directory, name)))) root = directory;
      else if (parent !== directory && !isTempRoot(directory)) root = projectRoot(parent);
      roots.set(directory, root);
    }
    return roots.get(directory);
  }
  return (file: string): string => {
    const cached = relatives.get(file);
    if (cached !== undefined) return cached;
    const absolute = path.resolve(file);
    const root = projectRoot(path.dirname(absolute));
    const result = root ? path.relative(root, absolute) : path.basename(absolute);
    relatives.set(file, result);
    return result;
  };
}

const relativeToProject = createProjectRelativizer();
const testSourceCache = new Map<string, boolean>();

function isTestSource(file: string): boolean {
  const cached = testSourceCache.get(file);
  if (cached !== undefined) return cached;
  const result =
    testSourcePattern.test(file) ||
    testDirectoryPattern.test(relativeToProject(file)) ||
    testDirectoryPattern.test(workspaceScopedPath(file));
  testSourceCache.set(file, result);
  return result;
}

function isSeedSource(file: string): boolean {
  return seedSourcePattern.test(relativeToProject(file));
}

// Operator tooling: a tooling folder, a database run script, or a standalone process entry point
// (a `require.main === module` guard, or a top-level `main()` that sets the exit status).
function isToolingSource(source: SourceFile): boolean {
  const relative = relativeToProject(source.fileName);
  return (
    toolingDirectoryPattern.test(relative) ||
    databaseScriptPattern.test(relative) ||
    (privateProcessEntries(source).size > 0 && !exportsFromModule(source))
  );
}

const moduleExportsCache = new WeakMap<SourceFile, boolean>();
const hookExportsCache = new WeakMap<SourceFile, boolean>();

function isCommonJsExportTarget(node: Node): boolean {
  let current = node;
  while (ts.isPropertyAccessExpression(current)) {
    const parent = current.expression;
    if (ts.isIdentifier(parent)) {
      return parent.text === 'exports' || (parent.text === 'module' && current.name.text === 'exports');
    }
    current = parent;
  }
  return false;
}

// `module.exports = …`, `module.exports.name = …` or `exports.name = …`.
function isCommonJsExport(statement: Statement): boolean {
  if (!ts.isExpressionStatement(statement)) return false;
  const assignment = statement.expression;
  if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  return isCommonJsExportTarget(assignment.left);
}

// A module that exports code is also imported by other code, so its entry point does not make it
// standalone tooling.
function hasExportModifier(statement: Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    Boolean(ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
  );
}

function exportsFromModule(source: SourceFile): boolean {
  let cached = moduleExportsCache.get(source);
  if (cached === undefined) {
    cached = source.statements.some(
      (statement) =>
        ts.isExportDeclaration(statement) ||
        ts.isExportAssignment(statement) ||
        isCommonJsExport(statement) ||
        hasExportModifier(statement),
    );
    moduleExportsCache.set(source, cached);
  }
  return cached;
}

// Browser UI modules: they import a UI framework and export a hook or composable (`useX`), or the
// code runs inside such a hook or a hook callback such as `useMemo(() => …)`. Their lists hold UI
// state, not server data.
const uiFrameworkModules = new Set(['react', 'preact', 'vue', 'svelte', 'solid-js']);
const hookNamePattern = /^use[A-Z]/;
const uiFrameworkSources = new WeakMap<SourceFile, boolean>();

function importsUiFramework(source: SourceFile): boolean {
  if (!uiFrameworkSources.has(source)) {
    uiFrameworkSources.set(
      source,
      source.statements.some(
        (statement: Statement) =>
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          uiFrameworkModules.has(statement.moduleSpecifier.text),
      ),
    );
  }
  return uiFrameworkSources.get(source) === true;
}

function hookDeclarationName(statement: Statement): string | undefined {
  if (ts.isFunctionDeclaration(statement)) return statement.name?.text;
  if (!ts.isVariableStatement(statement)) return;
  const [declaration] = statement.declarationList.declarations;
  const value = declaration?.initializer && ts.skipOuterExpressions(declaration.initializer);
  if (value && ts.isFunctionLike(value) && ts.isIdentifier(declaration.name)) return declaration.name.text;
}

function exportsHook(source: SourceFile): boolean {
  let cached = hookExportsCache.get(source);
  if (cached === undefined) {
    cached = source.statements.some(
      (statement) => hasExportModifier(statement) && hookNamePattern.test(hookDeclarationName(statement) ?? ''),
    );
    hookExportsCache.set(source, cached);
  }
  return cached;
}

function runsInsideHook(node: Node): boolean {
  return !!ts.findAncestor(node, (ancestor) => {
    if (!ts.isFunctionLike(ancestor)) return false;
    const holder = ancestor.parent;
    const name = ts.isFunctionDeclaration(ancestor)
      ? ancestor.name?.text
      : ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)
        ? holder.name.text
        : undefined;
    if (name && hookNamePattern.test(name)) return true;
    return (
      ts.isCallExpression(holder) &&
      holder.arguments.some((argument) => argument === ancestor) &&
      ts.isIdentifier(holder.expression) &&
      hookNamePattern.test(holder.expression.text)
    );
  });
}

function clientHookContext(node: Node, source: SourceFile): string | undefined {
  if (!importsUiFramework(source) || !(exportsHook(source) || runsInsideHook(node))) return;
  return 'Runs in a browser UI hook or composable module over UI state rather than on a server request path. Review in a front-end context if the list can grow large.';
}

function setupSourceContext(source: SourceFile, ruleId: string): string | undefined {
  const file = source.fileName;
  const runtime = classifyExecutionContext(source).runtime;
  if (isTestSource(file) || runtime === 'test-fixture') return 'Runs in a test source rather than a request path.';
  if (runtime === 'cli-tooling' && ruleId !== 'http-call-without-timeout')
    return 'Runs in CLI or developer tooling rather than a request path.';
  if (ruleId === 'await-before-early-exit' && runtime === 'browser')
    return 'Runs in a browser UI hook rather than a server request path.';
  if (isSeedSource(file)) return 'Runs in seed or demo-data setup rather than a request path.';
  if (buildConfigPattern.test(file)) return 'Runs in a build or tool configuration file rather than a request path.';
  if (isToolingSource(source))
    return 'Runs in operator tooling (scripts, standalone entry points, deployment, migrations or commands) rather than a request path.';
}

function perItemQueryContext(ruleId: string, source: SourceFile): string | undefined {
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

function lookupSourceContext(node: Node, source: SourceFile): string | undefined {
  const file = source.fileName;
  const runtime = classifyExecutionContext(source).runtime;
  if (isTestSource(file) || runtime === 'test-fixture')
    return 'Lookup in a test source. Review only if the fixture can grow large.';
  if (clientSourcePattern.test(file))
    return 'Client UI render code rather than a server request path. Review in a front-end context.';
  const hookReason = clientHookContext(node, source);
  if (hookReason) return hookReason;
  if (isSeedSource(file))
    return 'Seed or demo-data setup runs outside request paths. Review if the data set can grow large.';
  if (
    isToolingSource(source) ||
    runtime === 'cli-tooling' ||
    lookupToolingDirectoryPattern.test(rootRelativePath(file))
  )
    return 'Lookup in operator or container tooling that runs once rather than on a request path. Review if the data set can grow large.';
}

function blockingSourceContext(node: Node, checker: CheckerAdapter, source: SourceFile): string | undefined {
  const file = source.fileName;
  const runtime = classifyExecutionContext(source).runtime;
  if (isTestSource(file) || runtime === 'test-fixture')
    return 'Synchronous call in a test source rather than a request path.';
  if (isSeedSource(file)) return 'Synchronous call in seed or demo-data setup rather than a request path.';
  if (buildConfigPattern.test(file))
    return 'Synchronous call in a build or tool configuration file, which runs when the tool starts rather than on a request path.';
  if (blockingToolingDirectoryPattern.test(rootRelativePath(file)))
    return 'Synchronous call in container, boot, codemod, tooling or test-support code rather than a request path.';
  if ((runtime === 'cli-tooling' || isToolingSource(source)) && !findRepeatOwner(node, checker)) {
    return 'Synchronous call in operator or CLI tooling (scripts, deployment, migrations or commands). Prioritize if the server also imports this module.';
  }
}

function sourceKindContext(
  node: Node,
  ruleId: string,
  checker: CheckerAdapter,
  source: SourceFile,
): string | undefined {
  if (perItemQueryRules.has(ruleId)) return perItemQueryContext(ruleId, source);
  if (setupContextRules.has(ruleId)) return setupSourceContext(source, ruleId);
  if (lookupRules.has(ruleId)) return lookupSourceContext(node, source);
  if (blockingRules.has(ruleId)) return blockingSourceContext(node, checker, source);
}

function repeatedReviewContext(
  node: Node,
  ruleId: string,
  checker: CheckerAdapter,
  source: SourceFile,
): string | undefined {
  return (
    specificReviewContext(node, ruleId, checker, source) ??
    sourceKindContext(node, ruleId, checker, source) ??
    loopShapeContext(node, ruleId, checker)
  );
}

function loopShapeContext(node: Node, ruleId: string, checker: CheckerAdapter): string | undefined {
  if (!loopRules.has(ruleId)) return;
  const call = ts.findAncestor(node, ts.isCallExpression);
  return call && loopReviewReason(call, findRepeatOwner(call, checker), checker, ruleId);
}

function specificReviewContext(
  node: Node,
  ruleId: string,
  checker: CheckerAdapter,
  source: SourceFile,
): string | undefined {
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

function createTestWriteClassifier(): (file: string, ruleId: string) => string | undefined {
  const relativize = createProjectRelativizer();
  return (file, ruleId) => {
    if (!testWriteRules.has(ruleId)) return;
    return testWriteContext(relativize(file), ruleId);
  };
}

export {
  clientHookContext,
  clientSourcePattern,
  isToolingSource,
  relativeToProject,
  reviewedReason,
  reviewMarkers,
  testWriteContext,
  createTestWriteClassifier,
  repeatedReviewContext,
  isTestSource,
  isSeedSource,
};
