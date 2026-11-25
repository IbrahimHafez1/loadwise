// Scan for changed-lines mode: analyses only the changed files, while imports still resolve against
// the whole project. Once that many files changed, the full scan is faster (it runs on threads) and
// keeps every rule, so it runs instead. Cross-file rules that need every file are skipped:
// duplicate-implementation, and dependency cycles that pass through unchanged files. Folder
// boundaries and placement rules still run, since they only need the changed files' imports.
import { listFiles, createResolver } from './inputs.js';
import { archivedCopies, sourceContext } from './snapshot-context.js';
import { checkGraph } from './architecture.js';
import { checkPlacement } from './layout.js';
import { analyzePolyglot } from './polyglot.js';
import { readSources, analyzeSource } from './analyze-source.js';
import type { Finding, SkippedFile } from '../shared/types.js';
import type { ModuleEdge } from './types/module-graph.js';
import type { MaintainabilityPolicy } from './types/policy.js';
import type { ScanOptions, SourceScan } from './types/scan-report.js';
import {
  scan,
  isAnalyzableSource,
  isOtherSource,
  reportUnparsable,
  reportUnparsablePolyglot,
  sourceCoverage,
  PARALLEL_FROM_FILES,
} from './scan.js';

async function scanChangedFiles(
  root: string,
  policy: MaintainabilityPolicy,
  changedFiles: readonly string[],
  { parallelFrom = PARALLEL_FROM_FILES, inScope }: ScanOptions = {},
): Promise<SourceScan> {
  if (changedFiles.length >= parallelFrom) return scan(root, policy, { inScope });
  const inventory = listFiles(root, policy.exclude, policy.isIgnored);
  const sourceFiles = inventory.filter(isAnalyzableSource);
  const known = new Set(sourceFiles);
  const targets = changedFiles.filter((file) => known.has(file)).sort();
  const changed = new Set(changedFiles);
  const polyglotTargets = inventory.filter((file) => changed.has(file) && isOtherSource(file));
  const resolve = createResolver(root, known);
  const texts = await readSources(root, targets);
  const findings: Finding[] = checkPlacement(inventory, policy.placement);
  const edges: ModuleEdge[] = [];
  const constEnums = new Map<string, string[]>();
  const generated = new Set<string>();
  const skippedFiles: SkippedFile[] = [];
  targets.forEach((file, index: number) => {
    const analysis = analyzeSource(root, file, texts[index], resolve, policy);
    if (analysis.parseError !== undefined) return reportUnparsable(skippedFiles, file, analysis.parseError);
    if (analysis.generated) generated.add(file);
    for (const finding of analysis.findings) findings.push(finding);
    for (const edge of analysis.edges) edges.push(edge);
    constEnums.set(file, analysis.constEnums);
  });
  const polyglot = await analyzePolyglot({ root, files: polyglotTargets, includeDuplicates: false });
  for (const finding of polyglot.findings) findings.push(finding);
  reportUnparsablePolyglot(skippedFiles, polyglot);
  for (const finding of checkGraph({ files: sourceFiles, edges, boundaries: policy.boundaries, constEnums }))
    findings.push(finding);
  const snapshots = archivedCopies(inventory);
  for (const finding of findings) {
    const reason = finding.contextualReason || sourceContext(finding, snapshots, generated);
    if (reason) finding.contextualReason = reason;
  }
  return {
    mode: 'source',
    ...sourceCoverage({
      inventory,
      jsFiles: targets,
      otherSources: polyglotTargets,
      edges,
      placementRuleCount: policy.placement.length,
      inScope,
    }),
    findings,
    ...(skippedFiles.length && { skippedFiles }),
  };
}

export { scanChangedFiles };
