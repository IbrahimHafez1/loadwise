'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isSourceInput(filename) {
  return /\.[cm]?[jt]sx?$/i.test(filename) && !/\.d\.[cm]?ts$/i.test(filename);
}

function compareFindings(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column ||
    left.ruleId.localeCompare(right.ruleId)
  );
}

// A shared source can be a test callback under one config and a request handler under another.
function mergeFinding(byKey, key, finding) {
  const existing = byKey.get(key);
  if (
    !existing ||
    (existing.contextualReason && (!finding.contextualReason || finding.contextualReason < existing.contextualReason))
  ) {
    byKey.set(key, finding);
  }
}

function resolveConfig(input) {
  const absolute = path.resolve(input);
  const info = fs.statSync(absolute, { throwIfNoEntry: false });
  if (info?.isFile()) return absolute;
  if (!info?.isDirectory()) throw new Error('Project config does not exist: ' + input);
  for (const filename of ['tsconfig.json', 'jsconfig.json']) {
    const candidate = path.join(absolute, filename);
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  }
  throw new Error('No tsconfig.json or jsconfig.json in ' + input + '. Pass source files explicitly.');
}

module.exports = { compareFindings, isSourceInput, mergeFinding, resolveConfig };
