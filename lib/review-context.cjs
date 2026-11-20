'use strict';

const { syntax: ts } = require('./compiler.cjs');
const fs = require('node:fs');
const path = require('node:path');

const reviewMarker = 'backend-perf-reviewed';
const directive = /^[\t ]*\/\/[\t ]+backend-perf-reviewed[\t ]+([a-z][a-z0-9-]*)[\t ]+--[\t ]+(\S[^\r\n]*?)[\t ]*$/;
const protectedRules = new Set([
  'data-access-boundary',
  'pg-transaction-on-pool',
  'prisma-scope-unverified',
  'drizzle-scope-unverified',
  'prisma-transaction-client-escape',
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

function createTestWriteClassifier() {
  const roots = new Map();
  function projectRoot(directory) {
    if (!roots.has(directory)) {
      const parent = path.dirname(directory);
      const boundary = ['package.json', 'tsconfig.json', 'jsconfig.json', '.git'].some((name) =>
        fs.existsSync(path.join(directory, name)),
      );
      let root;
      if (boundary) root = directory;
      else if (parent !== directory) root = projectRoot(parent);
      roots.set(directory, root);
    }
    return roots.get(directory);
  }
  return (file, ruleId) => {
    if (!testWriteRules.has(ruleId)) return;
    const absolute = path.resolve(file);
    const root = projectRoot(path.dirname(absolute));
    return testWriteContext(root ? path.relative(root, absolute) : path.basename(absolute), ruleId);
  };
}

module.exports = { reviewedReason, reviewMarker, testWriteContext, createTestWriteClassifier };
