import { findingLevel, repositoryPathFor } from './finding-location.js';
import type { Finding, SkippedFile } from '../types.js';
import type { FindingLevel, FormatPillar, ReportEntry, RepositoryPath } from '../types/report-formats.js';

// GitHub workflow commands: the message escapes % and line breaks, and properties also escape : and
// ,.
const commandNames: Record<FindingLevel, string> = { error: 'error', warning: 'warning', note: 'notice' };

function escapeData(text: string) {
  return String(text).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeProperty(text: string) {
  return escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

function annotation(pillar: FormatPillar, repositoryPath: RepositoryPath, finding: Finding) {
  const properties = [
    `file=${escapeProperty(repositoryPath(finding.file))}`,
    `line=${finding.line ?? 1}`,
    `col=${finding.column ?? 1}`,
    `title=${escapeProperty(finding.ruleId)}`,
  ];
  return `::${commandNames[findingLevel(pillar, finding)]} ${properties.join(',')}::${escapeData(finding.message)}`;
}

function skippedFileAnnotation(repositoryPath: RepositoryPath, { file, reason }: SkippedFile) {
  return `::warning file=${escapeProperty(repositoryPath(file))},title=${escapeProperty('skipped-file')}::${escapeData(reason)}`;
}

// entries: [{ pillar, root, report }] with a null report for a checker that did not run.
function formatGithub(entries: readonly ReportEntry[]): string {
  const lines = entries.flatMap(({ pillar, root, repositoryDirectory, report }: ReportEntry): string[] => {
    if (!report) return [];
    const repositoryPath = repositoryPathFor(root, repositoryDirectory);
    return [
      ...report.findings.map((finding: Finding) => annotation(pillar, repositoryPath, finding)),
      ...(report.skippedFiles ?? []).map((skipped: SkippedFile) => skippedFileAnnotation(repositoryPath, skipped)),
    ];
  });
  return lines.join('\n');
}

export { formatGithub, escapeData, escapeProperty };
