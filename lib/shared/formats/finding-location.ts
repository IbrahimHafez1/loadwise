// Shared by the formats that point at source: levels and repo-relative paths.
import fs from 'node:fs';
import path from 'node:path';
import { contractRules } from './contract-rules.js';
import { realTarget } from '../real-target.js';
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

// Both sides are resolved: a checker may report from a resolved working directory while the
// repository was found through a symlinked parent (macOS /var -> /private/var), which would turn the
// path into a chain of "../".
function repositoryPathFor(findingRoot: string, repositoryDirectory = findingRoot): RepositoryPath {
  const repository = realTarget(findRepositoryRoot(repositoryDirectory));
  return (file: string | undefined) =>
    path
      .relative(repository, realTarget(path.resolve(findingRoot, file ?? '')))
      .split(path.sep)
      .join('/');
}

export { findingLevel, repositoryPathFor };
