'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { checkPrismaCall } = require('./prisma.cjs');
const { checkPostgresCall } = require('./postgres.cjs');
const { checkPgIntegrity } = require('./pg-integrity.cjs');
const { checkPrismaIntegrity } = require('./prisma-integrity.cjs');
const { checkDependentWrites } = require('./dependent-writes.cjs');
const { checkDrizzleCall } = require('./drizzle.cjs');
const { checkOrmQuery } = require('./orm-queries.cjs');
const { checkQueryPolicy } = require('./query-policy.cjs');
const { accessChecker } = require('./data-access.cjs');
const { checkPromiseAwait } = require('./awaits.cjs');
const { checkSortExtreme } = require('./sort-extreme.cjs');
const { checkNodeBlockingCall, flushBlockingCalls } = require('./node-fs.cjs');
const { checkPoolCreation } = require('./pooling.cjs');
const { checkCollectionCall, checkCollectionAssignment } = require('./collections.cjs');
const { isRepeated } = require('./repeated.cjs');
const { reviewedReason, reviewMarker } = require('./review-context.cjs');

const drizzlePrograms = new WeakMap();

function includesDrizzle(program) {
  if (!program.getSourceFiles) return true;
  if (!drizzlePrograms.has(program)) {
    // The rule only accepts signatures declared inside this package. Cache per compiler snapshot.
    drizzlePrograms.set(
      program,
      program
        .getSourceFiles()
        .some((source) => source.fileName.replaceAll('\\', '/').includes('/node_modules/drizzle-orm/')),
    );
  }
  return drizzlePrograms.get(program);
}

function typeFromPackage(type, packages, typeNames) {
  if (type.isUnion()) {
    const members = type.types.filter((member) => !(member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
    return members.length > 0 && members.every((member) => typeFromPackage(member, packages, typeNames));
  }
  const symbol = type.getSymbol();
  if (!symbol || (typeNames && !typeNames.includes(symbol.name))) return false;
  return (
    symbol.declarations?.some((declaration) => {
      const filename = declaration.getSourceFile().fileName.replaceAll('\\', '/');
      const marker = '/node_modules/';
      const start = filename.lastIndexOf(marker);
      if (start < 0) return false;
      const withinModules = filename.slice(start + marker.length);
      return packages.some((name) => withinModules.startsWith(name + '/'));
    }) ?? false
  );
}

function analyzeFile(program, sourceFile, policy, forEachSourceCandidate = program.forEachSourceCandidate) {
  const checker = program.getTypeChecker();
  const findings = [];
  const checkDrizzle = includesDrizzle(program);
  const pendingBlockingCalls = checker.getSymbolsAtLocations ? [] : undefined;
  let hasReviewComments;
  const context = {
    checker,
    strictNullChecks: policy
      ? Boolean(program.getCompilerOptions().strictNullChecks ?? program.getCompilerOptions().strict)
      : false,
    verbatimModuleSyntax: policy ? Boolean(program.getCompilerOptions().verbatimModuleSyntax) : false,
    isRepeated: (node) => isRepeated(node, checker),
    isPackageType: (node, packages, typeNames) => typeFromPackage(checker.getTypeAtLocation(node), packages, typeNames),
    report(node, ruleId, message, contextualReason) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      hasReviewComments ??= sourceFile.text.includes(reviewMarker);
      const reason = (hasReviewComments && reviewedReason(sourceFile, line, ruleId)) || contextualReason;
      const finding = { file: sourceFile.fileName, line: line + 1, column: character + 1, ruleId, message };
      if (reason) finding.contextualReason = reason;
      findings.push(finding);
    },
  };
  const checkAccess = policy?.dataAccess && accessChecker(sourceFile, context, policy.dataAccess);
  const checkParallelReads = policy?.parallelReads && require('./parallel-reads.cjs').checkParallelReads;
  function checkNode(node) {
    if (ts.isCallExpression(node)) {
      checkPromiseAwait(node, context);
      checkSortExtreme(node, context);
      checkPostgresCall(node, context);
      checkPgIntegrity(node, context);
      checkPrismaCall(node, context);
      checkPrismaIntegrity(node, context);
      checkDependentWrites(node, context);
      if (checkDrizzle) checkDrizzleCall(node, context, policy?.drizzleScopes);
      checkOrmQuery(node, context);
      if (policy?.prismaScopes) checkQueryPolicy(node, context, policy);
      checkNodeBlockingCall(node, context, pendingBlockingCalls);
      checkCollectionCall(node, context);
      checkPoolCreation(node, context);
    } else if (ts.isNewExpression(node)) {
      checkPoolCreation(node, context);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      checkCollectionAssignment(node, context);
    }
  }
  if (forEachSourceCandidate && !checkAccess && !checkParallelReads) {
    forEachSourceCandidate(sourceFile, checkNode);
  } else {
    function visit(node) {
      if (checkAccess) checkAccess(node);
      if (checkParallelReads && (ts.isBlock(node) || ts.isSourceFile(node))) {
        checkParallelReads(node, context, policy.parallelReads);
      }
      checkNode(node);
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  if (pendingBlockingCalls?.length) flushBlockingCalls(pendingBlockingCalls, context);
  return findings.sort(
    (left, right) => left.line - right.line || left.column - right.column || left.ruleId.localeCompare(right.ruleId),
  );
}

module.exports = { analyzeFile };
