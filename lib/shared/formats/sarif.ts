import packageManifest from '../../../package.json' with { type: 'json' };
const { version: toolVersion } = packageManifest;

import { findingLevel, repositoryPathFor } from './finding-location.js';
import type { Finding, SkippedFile } from '../types.js';
import type { FormatPillar, RanReportEntry, ReportEntry, RepositoryPath } from '../types/report-formats.js';
import { rulesByPillar } from '../rule-registry.js';
import { repositoryUrl, ruleDocUrl } from '../rule-docs.js';

const sarifSchema = 'https://json.schemastore.org/sarif-2.1.0.json';
const fingerprintKey = 'loadwise/findingId/v1';
const sourceRootId = '%SRCROOT%';

// Messages carry per-site detail, so a rule without a registered description is summarized by its
// first sentence.
function shortDescription(pillar: FormatPillar, ruleId: string, message: string) {
  return rulesByPillar[pillar].descriptionByRule[ruleId] ?? message.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? message;
}

interface SarifRule {
  id: string;
  shortDescription: { text: string };
  helpUri: string;
}

function rulesFor(pillar: FormatPillar, findings: Finding[]): SarifRule[] {
  const rules = new Map<string, SarifRule>();
  for (const { ruleId, message } of findings) {
    if (rules.has(ruleId)) continue;
    rules.set(ruleId, {
      id: ruleId,
      shortDescription: { text: shortDescription(pillar, ruleId, message) },
      helpUri: ruleDocUrl(ruleId) ?? repositoryUrl,
    });
  }
  return [...rules.values()];
}

function resultFor(pillar: FormatPillar, repositoryPath: RepositoryPath, finding: Finding) {
  const uri = repositoryPath(finding.file).split('/').map(encodeURIComponent).join('/');
  return {
    ruleId: finding.ruleId,
    level: findingLevel(pillar, finding),
    message: { text: finding.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri, uriBaseId: sourceRootId },
          region: { startLine: finding.line ?? 1, startColumn: finding.column ?? 1 },
        },
      },
    ],
    partialFingerprints: { [fingerprintKey]: finding.id },
    ...(finding.impactLevel ? { properties: { impact: finding.impactLevel } } : {}),
  };
}

// A skipped file is coverage the run lacks, so the run is marked unsuccessful and names each file.
function invocationsFor(repositoryPath: RepositoryPath, skippedFiles: readonly SkippedFile[] | undefined) {
  if (!skippedFiles?.length) return {};
  const notifications = skippedFiles.map(({ file, reason }) => ({
    level: 'error',
    message: { text: `Skipped ${file}: ${reason}` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: repositoryPath(file).split('/').map(encodeURIComponent).join('/'),
            uriBaseId: sourceRootId,
          },
        },
      },
    ],
  }));
  return { invocations: [{ executionSuccessful: false, toolExecutionNotifications: notifications }] };
}

function runFor({ pillar, root, repositoryDirectory, report }: RanReportEntry) {
  const findings = report.findings;
  const repositoryPath = repositoryPathFor(root, repositoryDirectory);
  return {
    tool: {
      driver: {
        name: 'loadwise',
        version: toolVersion,
        informationUri: repositoryUrl,
        rules: rulesFor(pillar, findings),
      },
    },
    automationDetails: { id: `loadwise/${pillar}/` },
    originalUriBaseIds: { [sourceRootId]: { description: { text: 'Root of the checked repository or project.' } } },
    results: findings.map((finding: Finding) => resultFor(pillar, repositoryPath, finding)),
    ...invocationsFor(repositoryPath, report.skippedFiles),
  };
}

// One run per pillar that produced a report, so code scanning keeps their alerts apart.
function hasReport(entry: ReportEntry): entry is RanReportEntry {
  return Boolean(entry.report);
}

function formatSarif(entries: readonly ReportEntry[]): string {
  const runs = entries.filter(hasReport).map(runFor);
  return JSON.stringify({ version: '2.1.0', $schema: sarifSchema, runs }, null, 2);
}

export { formatSarif };
