import { ts } from './compiler.js';
import { check as checkServiceLoops } from './service-loops.js';
import { checkAwsClient, check as checkHttpTimeouts } from './http-timeouts.js';
import { check as checkLiteralAwaits } from './literal-awaits.js';
import { check as checkTypeormUpdates } from './typeorm-updates.js';
import { check as checkQueueLoops } from './queue-loops.js';
import { check as checkUploadLimits } from './upload-limits.js';
import { check as checkPrismaAggregates } from './prisma-aggregates.js';
import { check as checkTransactionIo } from './transaction-io.js';
import { check as checkPureJsHashing } from './pure-js-hashing.js';
import { check as checkPageCounts } from './page-counts.js';
import { check as checkTypeormUnusedCount } from './typeorm-unused-count.js';
import { check as checkRedisKeys } from './redis-keys.js';
import { check as checkGuardQueries } from './guard-queries.js';
import { check as checkAwaitBeforeEarlyExit } from './await-before-early-exit.js';
import { check as checkFindThenCreate } from './find-then-create.js';
import { check as checkUnboundedListQueries } from './unbounded-list-queries.js';
import { checkAssignment as checkCacheAssignment, check as checkMemoryGrowth } from './memory-growth.js';
import { check as checkListOverfetch } from './list-overfetch.js';
import { check as checkOffsetPagination } from './offset-pagination.js';
import { check as checkListCounts } from './list-counts.js';
import { check as checkNotificationLoops } from './notification-loops.js';
import { check as checkSessionStore } from './session-store.js';
import { check as checkCartesianIncludes } from './cartesian-includes.js';
import { check as checkRetryBackoff } from './retry-backoff.js';
import { check as checkJsonClone } from './json-clone.js';
import { check as checkAsyncErrors } from './async-errors.js';
import { check as checkMongoosePatterns } from './mongoose-patterns.js';
import { check as checkRequestHeavyWork } from './request-heavy-work.js';
import { check as checkBackendMastery } from './backend-mastery.js';
import { checkParallelReads as runParallelReads } from './parallel-reads.js';
import { checkPrismaCall, checkPrismaRawTemplate } from './prisma.js';
import { checkPostgresCall } from './postgres.js';
import { checkRedisCall } from './redis.js';
import { checkPasswordHashing } from './password-hashing.js';
import { checkPgIntegrity } from './pg-integrity.js';
import { checkPrismaIntegrity } from './prisma-integrity.js';
import { checkDependentWrites } from './dependent-writes.js';
import { checkDrizzleCall } from './drizzle.js';
import { checkWritePreflight } from './drizzle-write-preflight.js';
import { checkOrmQuery } from './orm-queries.js';
import { createTransactionLoopCheck } from './typeorm-transaction-loops.js';
import { checkPromiseAwait } from './awaits.js';
import { checkSortExtreme } from './sort-extreme.js';
import { checkNodeBlockingCall, flushBlockingCalls } from './node-fs.js';
import { checkPoolCreation } from './pooling.js';
import { checkCollectionCall, checkCollectionAssignment } from './collections.js';
import { isRepeated } from './repeated.js';
import { isTestSource, reviewedReason, reviewMarkers, repeatedReviewContext } from './review-context.js';
import { checkIndexUsage } from './index-rules.js';
import { isLoopRule, loopImpact } from './impact.js';
import { currentSnapshot } from './schema/context.js';
import { typeFromPackage } from './package-types.js';
import { checkDiscardedErrorResult } from './discarded-error-result.js';
import { check as checkFloatingPromise } from './floating-promises.js';
import { checkPromiseReturnEscapesCatch } from './promise-return-escapes-catch.js';
import { checkReturnInFinally } from './return-in-finally.js';
import { checkReturnNewline } from './return-newline.js';
import { checkFrontendFile, checkFrontendNode } from './frontend-perf.js';
import { checkPhase5PerfNode, collectPhase5PerfFindings, phase5CliReason } from './phase5-rules.js';
import { checkLastInsertId } from './last-insert-id.js';
import { checkWorkbookDecodes } from './workbook-decodes.js';
import { isVendoredMinified } from '../shared/execution-context.js';
import { hotPathOf } from '../shared/hot-path-graph.js';
import type { CallExpression, Node, SourceFile } from 'typescript';
import type { PerformancePolicy } from './types/performance-policy.js';
import type { Finding, PerformanceRuleContext, ProgramAdapter, ReportDetails, TypeAdapter } from '../shared/types.js';

/** A rule that inspects one call expression and reports through the shared context. */
type CallRule = (call: CallExpression, context: PerformanceRuleContext) => void;

function checkUnhandledResult(call: CallExpression, context: PerformanceRuleContext): void {
  if (!checkDiscardedErrorResult(call, context)) checkFloatingPromise(call, context);
}

import { check as checkStreamErrors } from './stream-errors.js';

// Rules that each inspect one call expression and report through the shared context.
const callRules: CallRule[] = [
  checkServiceLoops,
  checkHttpTimeouts,
  checkLiteralAwaits,
  checkTypeormUpdates,
  checkQueueLoops,
  checkUploadLimits,
  checkPrismaAggregates,
  checkTransactionIo,
  checkPureJsHashing,
  checkPageCounts,
  checkTypeormUnusedCount,
  checkRedisKeys,
  checkGuardQueries,
  checkAwaitBeforeEarlyExit,
  checkUnhandledResult,
  checkFindThenCreate,
  checkUnboundedListQueries,
  checkMemoryGrowth,
  checkListOverfetch,
  checkOffsetPagination,
  checkListCounts,
  checkNotificationLoops,
  checkSessionStore,
  checkCartesianIncludes,
  checkRetryBackoff,
  checkJsonClone,
  checkAsyncErrors,
  checkStreamErrors,
  checkMongoosePatterns,
  checkRequestHeavyWork,
  checkBackendMastery,
];

const drizzlePrograms = new WeakMap<ProgramAdapter, boolean>();
const drizzleImport = /['"]drizzle-orm(?:\/[^'"]*)?['"]/;

function includesDrizzle(program: ProgramAdapter): boolean {
  if (!program.getSourceFiles) return true;
  const known = drizzlePrograms.get(program);
  if (known !== undefined) return known;
  // The rule accepts signatures declared inside this package, or, when its types are not installed,
  // a project import of it (the model fallback in drizzle.cjs then decides). Cache per compiler
  // snapshot.
  const included = program
    .getSourceFiles()
    .some(
      (source) =>
        source.fileName.replaceAll('\\', '/').includes('/node_modules/drizzle-orm/') ||
        (!source.isDeclarationFile && drizzleImport.test(source.text)),
    );
  drizzlePrograms.set(program, included);
  return included;
}

function analyzeFile(
  program: ProgramAdapter,
  sourceFile: SourceFile,
  policy?: PerformancePolicy,
  forEachSourceCandidate = program.forEachSourceCandidate,
): Finding[] {
  if (isVendoredMinified(sourceFile.fileName)) return [];
  const checker = program.getTypeChecker();
  const findings: Finding[] = [];
  const checkDrizzle = includesDrizzle(program);
  const hasLastInsertId = checkDrizzle && /last_insert_id/i.test(sourceFile.text);
  const pendingBlockingCalls: CallExpression[] | undefined = checker.getSymbolsAtLocations ? [] : undefined;
  const checkTransactionLoop = createTransactionLoopCheck(sourceFile, checker);
  const snapshot = currentSnapshot();
  const compilerOptions = policy ? program.getCompilerOptions() : undefined;
  const repeatedCache = new WeakMap<Node, boolean>();
  const nodeTypes = new WeakMap<Node, TypeAdapter>();
  let hasReviewComments: boolean | undefined;
  const context: PerformanceRuleContext = {
    checker,
    program,
    strictNullChecks: compilerOptions ? Boolean(compilerOptions.strictNullChecks ?? compilerOptions.strict) : false,
    verbatimModuleSyntax: compilerOptions ? Boolean(compilerOptions.verbatimModuleSyntax) : false,
    fireAndForgetNames: new Set(policy?.fireAndForget),
    isRepeated(node: Node) {
      let repeated = repeatedCache.get(node);
      if (repeated === undefined) {
        repeated = isRepeated(node, checker);
        repeatedCache.set(node, repeated);
      }
      return repeated;
    },
    isPackageType(node: Node, packages: readonly string[], typeNames?: readonly string[]) {
      let type = nodeTypes.get(node);
      if (type === undefined) {
        type = checker.getTypeAtLocation(node);
        nodeTypes.set(node, type);
      }
      return typeFromPackage(type, packages, typeNames);
    },
    // details carries optional suggestion and related links, which index rules attach.
    report(node: Node, ruleId: string, message: string, contextualReason?: string, details?: ReportDetails) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      hasReviewComments ??= reviewMarkers.some((marker) => sourceFile.text.includes(marker));
      const reason =
        (hasReviewComments && reviewedReason(sourceFile, line, ruleId)) ||
        contextualReason ||
        repeatedReviewContext(node, ruleId, checker, sourceFile);
      const finding: Finding = { file: sourceFile.fileName, line: line + 1, column: character + 1, ruleId, message };
      if (reason) finding.contextualReason = reason;
      if (details) Object.assign(finding, details);
      finding.hotPath = hotPathOf(node, program);
      if (isLoopRule(ruleId)) finding.impact = loopImpact(snapshot);
      findings.push(finding);
    },
  };
  const parallelReads = policy?.parallelReads;
  const checkParallelReads = parallelReads ? runParallelReads : undefined;
  function checkNode(node: Node): void {
    if (ts.isCallExpression(node)) {
      if (hasLastInsertId) checkLastInsertId(node, context);
      checkPromiseAwait(node, context);
      checkSortExtreme(node, context);
      checkPostgresCall(node, context);
      checkRedisCall(node, context);
      checkPasswordHashing(node, context);
      checkPgIntegrity(node, context);
      checkPrismaCall(node, context);
      checkPrismaIntegrity(node, context);
      checkDependentWrites(node, context);
      if (checkDrizzle) {
        checkDrizzleCall(node, context);
        checkWritePreflight(node, context);
      }
      checkOrmQuery(node, context);
      if (checkTransactionLoop) checkTransactionLoop(node, context);
      checkNodeBlockingCall(node, context, pendingBlockingCalls);
      checkCollectionCall(node, context);
      checkPoolCreation(node, context);
      checkIndexUsage(node, context);
      for (const check of callRules) check(node, context);
    } else if (ts.isPrefixUnaryExpression(node)) {
      // Unary plus converts request text to a number the same way Number(...) does.
      checkStreamErrors(node, context);
    } else if (ts.isTaggedTemplateExpression(node)) {
      checkPrismaRawTemplate(node, context);
    } else if (ts.isReturnStatement(node)) {
      checkPromiseReturnEscapesCatch(node, context);
      checkReturnInFinally(node, context);
      checkReturnNewline(node, context);
    } else if (ts.isNewExpression(node)) {
      checkPoolCreation(node, context);
      checkAwsClient(node, context);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      checkCollectionAssignment(node, context);
      checkCacheAssignment(node, context);
    }
  }
  const runFullFileRules = !isTestSource(sourceFile.fileName);
  if (forEachSourceCandidate && !checkParallelReads) {
    forEachSourceCandidate(sourceFile, checkNode);
    if (pendingBlockingCalls?.length) flushBlockingCalls(pendingBlockingCalls, context);
    checkWorkbookDecodes(sourceFile, context);
    if (runFullFileRules) {
      checkFrontendFile(sourceFile, context);
      collectPhase5PerfFindings(sourceFile, context);
    }
  } else {
    const cliReason = runFullFileRules ? phase5CliReason(sourceFile, context) : undefined;
    function visit(node: Node): void {
      if (checkParallelReads && parallelReads && (ts.isBlock(node) || ts.isSourceFile(node))) {
        checkParallelReads(node, context, parallelReads);
      }
      checkNode(node);
      if (runFullFileRules) {
        checkFrontendNode(node, context);
        checkPhase5PerfNode(node, sourceFile, context, cliReason);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    if (pendingBlockingCalls?.length) flushBlockingCalls(pendingBlockingCalls, context);
    checkWorkbookDecodes(sourceFile, context);
  }
  return findings.sort(
    (left, right) =>
      (left.line ?? 0) - (right.line ?? 0) ||
      (left.column ?? 0) - (right.column ?? 0) ||
      left.ruleId.localeCompare(right.ruleId),
  );
}

export { analyzeFile };
