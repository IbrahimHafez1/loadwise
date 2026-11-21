'use strict';

// Runs every registered security check over one source file: one full syntax walk, dispatched by node kind.
const { syntax: ts } = require('../performance/compiler.cjs');
const { typeFromPackage } = require('../performance/package-types.cjs');
const { reviewedReason, reviewMarkers, repeatedReviewContext } = require('../performance/review-context.cjs');
const { movedRules } = require('./rule-ids.cjs');
const { libraryCall } = require('./bindings.cjs');
const { createFileContext } = require('./file-context.cjs');
const { createTaint } = require('./taint/index.cjs');

// Each module exports { checks: { <ts.SyntaxKind name>: [(node, context) => void] } }. A rule group adds its
// checks to its own index.cjs; a new group is added to this list.
const registeredModules = [
  require('./pg-dynamic-query.cjs'),
  require('./scope/query-policy.cjs'),
  require('./scope/drizzle-policy.cjs'),
  require('./injection/index.cjs'),
  require('./request-forgery/index.cjs'),
  require('./auth-crypto/index.cjs'),
  require('./exposure/index.cjs'),
];
// The moved rules keep the review reasons they had as performance rules (seed, benchmark and tooling sources).
const movedRuleIds = new Set(movedRules);

function checksByKind(modules) {
  const byKind = new Map();
  for (const { checks } of modules) {
    for (const [kindName, kindChecks] of Object.entries(checks)) {
      const kind = ts.SyntaxKind[kindName];
      if (typeof kind !== 'number') throw new Error('Unknown syntax kind in security checks: ' + kindName);
      byKind.set(kind, [...(byKind.get(kind) ?? []), ...kindChecks]);
    }
  }
  return byKind;
}

// analyzeFile(program, sourceFile, policy) for the given modules; tests pass their own probe modules.
function createAnalyzer(modules) {
  const dispatch = checksByKind(modules);
  return function analyzeFile(program, sourceFile, policy) {
    const checker = program.getTypeChecker();
    const findings = [];
    const reported = new Set();
    const hasReviewComments = reviewMarkers.some((marker) => sourceFile.text.includes(marker));
    const fileContext = createFileContext(sourceFile);
    let taint;
    const context = {
      checker,
      sourceFile,
      policy,
      fileContext,
      strictNullChecks: policy
        ? Boolean(program.getCompilerOptions().strictNullChecks ?? program.getCompilerOptions().strict)
        : false,
      isPackageType: (node, packages, typeNames) =>
        typeFromPackage(checker.getTypeAtLocation(node), packages, typeNames),
      libraryCall: (call) => libraryCall(call, context),
      // Built on first use: most files have no sink.
      get taint() {
        return (taint ??= createTaint(program));
      },
      // details.taint (a trace result) becomes finding.trace; other details are copied onto the finding.
      report(node, ruleId, message, contextualReason, details) {
        const start = node.getStart(sourceFile);
        const key = start + ':' + ruleId;
        if (reported.has(key)) return;
        reported.add(key);
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
        const reason =
          (hasReviewComments && reviewedReason(sourceFile, line, ruleId)) ||
          contextualReason ||
          (movedRuleIds.has(ruleId)
            ? repeatedReviewContext(node, ruleId, checker, sourceFile)
            : fileContext.testSourceReason);
        const finding = { file: sourceFile.fileName, line: line + 1, column: character + 1, ruleId, message };
        if (reason) finding.contextualReason = reason;
        const { taint: traced, ...rest } = details ?? {};
        Object.assign(finding, rest);
        if (traced) finding.trace = traced.steps;
        findings.push(finding);
      },
    };
    (function visit(node) {
      const checks = dispatch.get(node.kind);
      if (checks) for (const check of checks) check(node, context);
      ts.forEachChild(node, visit);
    })(sourceFile);
    return findings.sort(
      (left, right) => left.line - right.line || left.column - right.column || left.ruleId.localeCompare(right.ruleId),
    );
  };
}

module.exports = { analyzeFile: createAnalyzer(registeredModules), createAnalyzer };
