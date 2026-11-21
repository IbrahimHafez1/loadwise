'use strict';

const { findingLevel, repositoryPathFor } = require('./finding-location.cjs');

// GitHub workflow commands: the message escapes % and line breaks, and properties also escape : and ,.
const commandNames = { error: 'error', warning: 'warning', note: 'notice' };

function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(text) {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function annotation(pillar, repositoryPath, finding) {
  const properties = [
    `file=${escapeProperty(repositoryPath(finding.file))}`,
    `line=${finding.line ?? 1}`,
    `col=${finding.column ?? 1}`,
    `title=${escapeProperty(finding.ruleId)}`,
  ];
  return `::${commandNames[findingLevel(pillar, finding)]} ${properties.join(',')}::${escapeData(finding.message)}`;
}

// entries: [{ pillar, root, report }] with a null report for a checker that did not run.
function formatGithub(entries) {
  const lines = entries.flatMap(({ pillar, root, repositoryDirectory, report }) => {
    if (!report) return [];
    const repositoryPath = repositoryPathFor(root, repositoryDirectory);
    return report.findings.map((finding) => annotation(pillar, repositoryPath, finding));
  });
  return lines.join('\n');
}

module.exports = { formatGithub, escapeData, escapeProperty };
