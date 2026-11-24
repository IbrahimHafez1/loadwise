import { loadSyntax } from './compiler.cjs';
import type * as ServiceLoops from './service-loops.cjs';
import type * as HttpTimeouts from './http-timeouts.cjs';
import type * as LiteralAwaits from './literal-awaits.cjs';
import type * as TypeormUpdates from './typeorm-updates.cjs';
import type * as QueueLoops from './queue-loops.cjs';
import type * as UploadLimits from './upload-limits.cjs';
import type * as PrismaAggregates from './prisma-aggregates.cjs';
import type * as TransactionIo from './transaction-io.cjs';
import type * as PureJsHashing from './pure-js-hashing.cjs';
import type * as PageCounts from './page-counts.cjs';
import type * as TypeormUnusedCount from './typeorm-unused-count.cjs';
import type * as RedisKeys from './redis-keys.cjs';
import type * as GuardQueries from './guard-queries.cjs';
import type * as AwaitBeforeEarlyExit from './await-before-early-exit.cjs';
import type * as FindThenCreate from './find-then-create.cjs';
import type * as UnboundedListQueries from './unbounded-list-queries.cjs';
import type * as MemoryGrowth from './memory-growth.cjs';
import type * as ListOverfetch from './list-overfetch.cjs';
import type * as OffsetPagination from './offset-pagination.cjs';
import type * as ListCounts from './list-counts.cjs';
import type * as NotificationLoops from './notification-loops.cjs';
import type * as SessionStore from './session-store.cjs';
import type * as CartesianIncludes from './cartesian-includes.cjs';
import type * as RetryBackoff from './retry-backoff.cjs';
import type * as JsonClone from './json-clone.cjs';
import type * as AsyncErrors from './async-errors.cjs';
import type * as MongoosePatterns from './mongoose-patterns.cjs';
import type * as RequestHeavyWork from './request-heavy-work.cjs';
import type * as BackendMastery from './backend-mastery.cjs';
import type * as ParallelReads from './parallel-reads.cjs';
import { checkPrismaCall, checkPrismaRawTemplate } from './prisma.cjs';
import { checkPostgresCall } from './postgres.cjs';
import { checkRedisCall } from './redis.cjs';
import { checkPasswordHashing } from './password-hashing.cjs';
import { checkPgIntegrity } from './pg-integrity.cjs';
import { checkPrismaIntegrity } from './prisma-integrity.cjs';
import { checkDependentWrites } from './dependent-writes.cjs';
import { checkDrizzleCall } from './drizzle.cjs';
import { checkWritePreflight } from './drizzle-write-preflight.cjs';
import { checkOrmQuery } from './orm-queries.cjs';
import { createTransactionLoopCheck } from './typeorm-transaction-loops.cjs';
import { checkPromiseAwait } from './awaits.cjs';
import { checkSortExtreme } from './sort-extreme.cjs';
import { checkNodeBlockingCall, flushBlockingCalls } from './node-fs.cjs';
import { checkPoolCreation } from './pooling.cjs';
import { checkAwsClient } from './http-timeouts.cjs';
import { checkCollectionCall, checkCollectionAssignment } from './collections.cjs';
import { checkAssignment as checkCacheAssignment } from './memory-growth.cjs';
import { isRepeated } from './repeated.cjs';
import { reviewedReason, reviewMarkers, repeatedReviewContext } from './review-context.cjs';
import { checkIndexUsage } from './index-rules.cjs';
import { isLoopRule, loopImpact } from './impact.cjs';
import { currentSnapshot } from './schema/context.cjs';
import { typeFromPackage } from './package-types.cjs';
import { checkDiscardedErrorResult } from './discarded-error-result.cjs';
import { check as checkFloatingPromise } from './floating-promises.cjs';
import { checkPromiseReturnEscapesCatch } from './promise-return-escapes-catch.cjs';
import { checkReturnInFinally } from './return-in-finally.cjs';
import { checkReturnNewline } from './return-newline.cjs';
import { checkFrontendFile } from './frontend-perf.cjs';
import { checkLastInsertId } from './last-insert-id.cjs';
import { checkWorkbookDecodes } from './workbook-decodes.cjs';
import { hotPathOf } from '../shared/hot-path.cjs';
import type { CallExpression, Node, SourceFile } from 'typescript';
import type { PerformancePolicy } from './types/performance-policy.cjs';
import type { Finding, PerformanceRuleContext, ProgramAdapter, ReportDetails } from '../shared/types.cjs';

/** A rule that inspects one call expression and reports through the shared context. */
type CallRule = (call: CallExpression, context: PerformanceRuleContext) => void;

function checkUnhandledResult(call: CallExpression, context: PerformanceRuleContext): void {
  if (!checkDiscardedErrorResult(call, context)) checkFloatingPromise(call, context);
}

import { check as checkStreamErrors } from './stream-errors.cjs';
const ts = loadSyntax();

const { check: checkServiceLoops }: typeof ServiceLoops = require('./service-loops.cjs');
const { check: checkHttpTimeouts }: typeof HttpTimeouts = require('./http-timeouts.cjs');
const { check: checkLiteralAwaits }: typeof LiteralAwaits = require('./literal-awaits.cjs');
const { check: checkTypeormUpdates }: typeof TypeormUpdates = require('./typeorm-updates.cjs');
const { check: checkQueueLoops }: typeof QueueLoops = require('./queue-loops.cjs');
const { check: checkUploadLimits }: typeof UploadLimits = require('./upload-limits.cjs');
const { check: checkPrismaAggregates }: typeof PrismaAggregates = require('./prisma-aggregates.cjs');
const { check: checkTransactionIo }: typeof TransactionIo = require('./transaction-io.cjs');
const { check: checkPureJsHashing }: typeof PureJsHashing = require('./pure-js-hashing.cjs');
const { check: checkPageCounts }: typeof PageCounts = require('./page-counts.cjs');
const { check: checkTypeormUnusedCount }: typeof TypeormUnusedCount = require('./typeorm-unused-count.cjs');
const { check: checkRedisKeys }: typeof RedisKeys = require('./redis-keys.cjs');
const { check: checkGuardQueries }: typeof GuardQueries = require('./guard-queries.cjs');
const { check: checkAwaitBeforeEarlyExit }: typeof AwaitBeforeEarlyExit = require('./await-before-early-exit.cjs');
const { check: checkFindThenCreate }: typeof FindThenCreate = require('./find-then-create.cjs');
const { check: checkUnboundedListQueries }: typeof UnboundedListQueries = require('./unbounded-list-queries.cjs');
const { check: checkMemoryGrowth }: typeof MemoryGrowth = require('./memory-growth.cjs');
const { check: checkListOverfetch }: typeof ListOverfetch = require('./list-overfetch.cjs');
const { check: checkOffsetPagination }: typeof OffsetPagination = require('./offset-pagination.cjs');
const { check: checkListCounts }: typeof ListCounts = require('./list-counts.cjs');
const { check: checkNotificationLoops }: typeof NotificationLoops = require('./notification-loops.cjs');
const { check: checkSessionStore }: typeof SessionStore = require('./session-store.cjs');
const { check: checkCartesianIncludes }: typeof CartesianIncludes = require('./cartesian-includes.cjs');
const { check: checkRetryBackoff }: typeof RetryBackoff = require('./retry-backoff.cjs');
const { check: checkJsonClone }: typeof JsonClone = require('./json-clone.cjs');
const { check: checkAsyncErrors }: typeof AsyncErrors = require('./async-errors.cjs');
const { check: checkMongoosePatterns }: typeof MongoosePatterns = require('./mongoose-patterns.cjs');
const { check: checkRequestHeavyWork }: typeof RequestHeavyWork = require('./request-heavy-work.cjs');
const { check: checkBackendMastery }: typeof BackendMastery = require('./backend-mastery.cjs');

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
  const checker = program.getTypeChecker();
  const findings: Finding[] = [];
  const checkDrizzle = includesDrizzle(program);
  const hasLastInsertId = checkDrizzle && /last_insert_id/i.test(sourceFile.text);
  const pendingBlockingCalls: CallExpression[] | undefined = checker.getSymbolsAtLocations ? [] : undefined;
  const checkTransactionLoop = createTransactionLoopCheck(sourceFile, checker);
  const snapshot = currentSnapshot();
  let hasReviewComments: boolean | undefined;
  const context: PerformanceRuleContext = {
    checker,
    program,
    strictNullChecks: policy
      ? Boolean(program.getCompilerOptions().strictNullChecks ?? program.getCompilerOptions().strict)
      : false,
    verbatimModuleSyntax: policy ? Boolean(program.getCompilerOptions().verbatimModuleSyntax) : false,
    fireAndForgetNames: new Set(policy?.fireAndForget),
    isRepeated: (node: Node) => isRepeated(node, checker),
    isPackageType: (node: Node, packages: readonly string[], typeNames?: readonly string[]) =>
      typeFromPackage(checker.getTypeAtLocation(node), packages, typeNames),
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
  const parallelReadsModule: typeof ParallelReads | undefined = parallelReads
    ? require('./parallel-reads.cjs')
    : undefined;
  const checkParallelReads = parallelReadsModule?.checkParallelReads;
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
  if (forEachSourceCandidate && !checkParallelReads) {
    forEachSourceCandidate(sourceFile, checkNode);
  } else {
    function visit(node: Node): void {
      if (checkParallelReads && parallelReads && (ts.isBlock(node) || ts.isSourceFile(node))) {
        checkParallelReads(node, context, parallelReads);
      }
      checkNode(node);
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  if (pendingBlockingCalls?.length) flushBlockingCalls(pendingBlockingCalls, context);
  checkWorkbookDecodes(sourceFile, context);
  checkFrontendFile(sourceFile, context);
  return findings.sort(
    (left, right) =>
      (left.line ?? 0) - (right.line ?? 0) ||
      (left.column ?? 0) - (right.column ?? 0) ||
      left.ruleId.localeCompare(right.ruleId),
  );
}

export { analyzeFile };
