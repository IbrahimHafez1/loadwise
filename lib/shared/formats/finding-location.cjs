'use strict';

// Shared by the formats that point at source: levels and repo-relative paths.
const fs = require('node:fs');
const path = require('node:path');
const { contractRules } = require('./contract-rules.cjs');

function findingLevel(pillar, finding) {
  if (contractRules[pillar].has(finding.ruleId)) return 'error';
  return finding.contextualReason ? 'note' : 'warning';
}

// Reports need paths relative to the repository root, while findings are relative to the scanned project.
function findRepositoryRoot(start) {
  for (let directory = path.resolve(start); ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, '.git'))) return directory;
    if (path.dirname(directory) === directory) return path.resolve(start);
  }
}

function repositoryPath(root, file) {
  const absolute = path.resolve(root, file);
  return path.relative(findRepositoryRoot(root), absolute).split(path.sep).join('/');
}

module.exports = { findingLevel, repositoryPath };
