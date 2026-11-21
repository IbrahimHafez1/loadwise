'use strict';

// Shared by the formats that point at source: levels and repo-relative paths.
const fs = require('node:fs');
const path = require('node:path');
const { contractRules } = require('./contract-rules.cjs');

function findingLevel(pillar, finding) {
  if (finding.level === 'warn') return 'warning';
  if (finding.level === 'error') return 'error';
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

function repositoryPathFor(findingRoot, repositoryDirectory = findingRoot) {
  const repository = findRepositoryRoot(repositoryDirectory);
  return (file) => path.relative(repository, path.resolve(findingRoot, file)).split(path.sep).join('/');
}

module.exports = { findingLevel, repositoryPathFor };
