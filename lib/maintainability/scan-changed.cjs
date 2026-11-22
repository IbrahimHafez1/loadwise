'use strict';

// Scan for changed-lines mode: analyses only the changed files, while imports still resolve against the whole project.
// Once that many files changed, the full scan is faster (it runs on threads) and keeps every rule, so it runs instead.
// Cross-file rules that need every file are skipped: duplicate-implementation, and dependency cycles that pass through
// unchanged files. Folder boundaries and placement rules still run, since they only need the changed files' imports.
const { listFiles, createResolver } = require('./inputs.cjs');
const { archivedCopies, sourceContext } = require('./snapshot-context.cjs');
const { checkGraph } = require('./architecture.cjs');
const { checkPlacement } = require('./layout.cjs');
const { analyzePolyglot } = require('./polyglot.cjs');
const { readSources, analyzeSource } = require('./analyze-source.cjs');
const { scan, isAnalyzableSource, isOtherSource, sourceCoverage, PARALLEL_FROM_FILES } = require('./scan.cjs');

async function scanChangedFiles(root, policy, changedFiles, { parallelFrom = PARALLEL_FROM_FILES, inScope } = {}) {
  if (changedFiles.length >= parallelFrom) return scan(root, policy, { inScope });
  const inventory = listFiles(root, policy.exclude, policy.isIgnored);
  const sourceFiles = inventory.filter(isAnalyzableSource);
  const known = new Set(sourceFiles);
  const targets = changedFiles.filter((file) => known.has(file)).sort();
  const changed = new Set(changedFiles);
  const polyglotTargets = inventory.filter((file) => changed.has(file) && isOtherSource(file));
  const resolve = createResolver(root, known);
  const texts = await readSources(root, targets);
  const findings = checkPlacement(inventory, policy.placement);
  const edges = [];
  const constEnums = new Map();
  const generated = new Set();
  targets.forEach((file, index) => {
    const analysis = analyzeSource(root, file, texts[index], resolve, policy);
    if (analysis.generated) generated.add(file);
    for (const finding of analysis.findings) findings.push(finding);
    for (const edge of analysis.edges) edges.push(edge);
    constEnums.set(file, analysis.constEnums);
  });
  const polyglot = await analyzePolyglot({ root, files: polyglotTargets, includeDuplicates: false });
  for (const finding of polyglot.findings) findings.push(finding);
  for (const finding of checkGraph({ files: sourceFiles, edges, boundaries: policy.boundaries, constEnums }))
    findings.push(finding);
  const snapshots = archivedCopies(inventory);
  for (const finding of findings) {
    const reason = finding.contextualReason || sourceContext(finding, snapshots, generated);
    if (reason) finding.contextualReason = reason;
  }
  return {
    mode: 'source',
    ...sourceCoverage(inventory, targets, polyglotTargets, edges, policy.placement.length, inScope),
    findings,
  };
}

module.exports = { scanChangedFiles };
