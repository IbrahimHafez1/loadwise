// Shared by the formats that point at source: levels and repo-relative paths.
import fs from 'node:fs';
import path from 'node:path';
import { contractRules } from './contract-rules.js';
import type { Finding } from '../types.js';
import type { FindingLevel, FormatPillar, RepositoryPath } from '../types/report-formats.js';

function findingLevel(pillar: FormatPillar, finding: Finding): FindingLevel {
  if (finding.level === 'warn') return 'warning';
  if (finding.level === 'error') return 'error';
  if (contractRules[pillar].has(finding.ruleId)) return 'error';
  return finding.contextualReason ? 'note' : 'warning';
}

// Reports need paths relative to the repository root, while findings are relative to the scanned
// project.
function findRepositoryRoot(start: string): string {
  for (let directory = path.resolve(start); ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, '.git'))) return directory;
    if (path.dirname(directory) === directory) return path.resolve(start);
  }
}

function repositoryPathFor(findingRoot: string, repositoryDirectory = findingRoot): RepositoryPath {
  const repository = findRepositoryRoot(repositoryDirectory);
  return (file: string | undefined) =>
    path
      .relative(repository, path.resolve(findingRoot, file ?? ''))
      .split(path.sep)
      .join('/');
}

export { findingLevel, repositoryPathFor };
