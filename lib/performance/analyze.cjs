'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { checkPrismaCall, checkPrismaRawTemplate } = require('./prisma.cjs');
const { checkPostgresCall } = require('./postgres.cjs');
const { checkRedisCall } = require('./redis.cjs');
const { checkPasswordHashing } = require('./password-hashing.cjs');
const { checkPgIntegrity } = require('./pg-integrity.cjs');
const { checkPrismaIntegrity } = require('./prisma-integrity.cjs');
const { checkDependentWrites } = require('./dependent-writes.cjs');
const { checkDrizzleCall } = require('./drizzle.cjs');
const { checkWritePreflight } = require('./drizzle-write-preflight.cjs');
const { checkOrmQuery } = require('./orm-queries.cjs');
const { createTransactionLoopCheck } = require('./typeorm-transaction-loops.cjs');
const { checkPromiseAwait } = require('./awaits.cjs');
const { checkSortExtreme } = require('./sort-extreme.cjs');
const { checkNodeBlockingCall, flushBlockingCalls } = require('./node-fs.cjs');
const { checkPoolCreation } = require('./pooling.cjs');
const { checkAwsClient } = require('./http-timeouts.cjs');
const { checkCollectionCall, checkCollectionAssignment } = require('./collections.cjs');
const { checkAssignment: checkCacheAssignment } = require('./memory-growth.cjs');
const { isRepeated } = require('./repeated.cjs');
const { reviewedReason, reviewMarkers, repeatedReviewContext } = require('./review-context.cjs');
const { checkIndexUsage } = require('./index-rules.cjs');
const { isLoopRule, loopImpact } = require('./impact.cjs');
const { currentSnapshot } = require('./schema/context.cjs');
const { typeFromPackage } = require('./package-types.cjs');
const { checkDiscardedErrorResult } = require('./discarded-error-result.cjs');
const { check: checkFloatingPromise } = require('./floating-promises.cjs');
const { checkPromiseReturnEscapesCatch } = require('./promise-return-escapes-catch.cjs');
const { checkReturnInFinally } = require('./return-in-finally.cjs');
const { checkReturnNewline } = require('./return-newline.cjs');
const { checkLastInsertId } = require('./last-insert-id.cjs');
const { checkWorkbookDecodes } = require('./workbook-decodes.cjs');
const { hotPathOf } = require('../shared/hot-path.cjs');

function checkUnhandledResult(call, context) {
  if (!checkDiscardedErrorResult(call, context)) checkFloatingPromise(call, context);
}

// Rules that each inspect one call expression and report through the shared context.
const callRules = [
  require('./service-loops.cjs').check,
  require('./http-timeouts.cjs').check,
  require('./literal-awaits.cjs').check,
  require('./typeorm-updates.cjs').check,
  require('./queue-loops.cjs').check,
  require('./upload-limits.cjs').check,
  require('./prisma-aggregates.cjs').check,
  require('./transaction-io.cjs').check,
  require('./pure-js-hashing.cjs').check,
  require('./page-counts.cjs').check,
  require('./typeorm-unused-count.cjs').check,
  require('./redis-keys.cjs').check,
  require('./guard-queries.cjs').check,
  require('./await-before-early-exit.cjs').check,
  checkUnhandledResult,
  require('./find-then-create.cjs').check,
  require('./unbounded-list-queries.cjs').check,
  require('./memory-growth.cjs').check,
  require('./list-overfetch.cjs').check,
];

const drizzlePrograms = new WeakMap();
const drizzleImport = /['"]drizzle-orm(?:\/[^'"]*)?['"]/;

function includesDrizzle(program) {
  if (!program.getSourceFiles) return true;
  if (!drizzlePrograms.has(program)) {
    // The rule accepts signatures declared inside this package, or, when its types are not installed, a project
    // import of it (the model fallback in drizzle.cjs then decides). Cache per compiler snapshot.
    drizzlePrograms.set(
      program,
      program
        .getSourceFiles()
        .some(
          (source) =>
            source.fileName.replaceAll('\\', '/').includes('/node_modules/drizzle-orm/') ||
            (!source.isDeclarationFile && drizzleImport.test(source.text)),
        ),
    );
  }
  return drizzlePrograms.get(program);
}

function analyzeFile(program, sourceFile, policy, forEachSourceCandidate = program.forEachSourceCandidate) {
  const checker = program.getTypeChecker();
  const findings = [];
  const checkDrizzle = includesDrizzle(program);
  const hasLastInsertId = checkDrizzle && /last_insert_id/i.test(sourceFile.text);
  const pendingBlockingCalls = checker.getSymbolsAtLocations ? [] : undefined;
  const checkTransactionLoop = createTransactionLoopCheck(sourceFile, checker);
  const snapshot = currentSnapshot();
  let hasReviewComments;
  const context = {
    checker,
    program,
    strictNullChecks: policy
      ? Boolean(program.getCompilerOptions().strictNullChecks ?? program.getCompilerOptions().strict)
      : false,
    verbatimModuleSyntax: policy ? Boolean(program.getCompilerOptions().verbatimModuleSyntax) : false,
    fireAndForgetNames: new Set(policy?.fireAndForget),
    isRepeated: (node) => isRepeated(node, checker),
    isPackageType: (node, packages, typeNames) => typeFromPackage(checker.getTypeAtLocation(node), packages, typeNames),
    // details carries optional suggestion and related links, which index rules attach.
    report(node, ruleId, message, contextualReason, details) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      hasReviewComments ??= reviewMarkers.some((marker) => sourceFile.text.includes(marker));
      const reason =
        (hasReviewComments && reviewedReason(sourceFile, line, ruleId)) ||
        contextualReason ||
        repeatedReviewContext(node, ruleId, checker, sourceFile);
      const finding = { file: sourceFile.fileName, line: line + 1, column: character + 1, ruleId, message };
      if (reason) finding.contextualReason = reason;
      if (details) Object.assign(finding, details);
      finding.hotPath = hotPathOf(node, program);
      if (isLoopRule(ruleId)) finding.impact = loopImpact(snapshot);
      findings.push(finding);
    },
  };
  const checkParallelReads = policy?.parallelReads && require('./parallel-reads.cjs').checkParallelReads;
  function checkNode(node) {
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
    function visit(node) {
      if (checkParallelReads && (ts.isBlock(node) || ts.isSourceFile(node))) {
        checkParallelReads(node, context, policy.parallelReads);
      }
      checkNode(node);
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  if (pendingBlockingCalls?.length) flushBlockingCalls(pendingBlockingCalls, context);
  checkWorkbookDecodes(sourceFile, context);
  return findings.sort(
    (left, right) => left.line - right.line || left.column - right.column || left.ruleId.localeCompare(right.ruleId),
  );
}

module.exports = { analyzeFile };
