import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { Worker } from 'node:worker_threads';
import { listFiles, createResolver } from './inputs.js';
import { createDuplicateIndex } from './duplicates.js';
import { archivedCopies, sourceContext } from './snapshot-context.js';
import { checkGraph } from './architecture.js';
import { createEntryPoints } from './entry-points.js';
import { checkUnusedModules } from './unused-modules.js';
import { collectModuleUsage } from './module-usage.js';
import { checkPlacement } from './layout.js';
import { nonJsLanguages, analyzePolyglot } from './polyglot.js';
import { readSourceFiles, analyzeSource } from './analyze-source.js';
import { identifierIndexOf, isPrivateManifest } from './source-facts.js';
import { recordSkippedFile } from '../performance/scan-outcome.js';
import type { Finding, SkippedFile } from '../shared/types.js';
import type { ModuleEdge } from './types/module-graph.js';
import type { ModuleUsage } from './types/module-usage.js';
import type { MaintainabilityPolicy } from './types/policy.js';
import type { PolyglotAnalysis } from './types/polyglot-scan.js';
import type { ScanOptions, SourceCoverage, SourceCoverageInput, SourceScan } from './types/scan-report.js';
import type { BatchReply, BatchRequest, ScanWorkerData } from './types/scan-worker.js';
import type { AnalysisOptions, SourceAnalysis } from './types/source-analysis.js';
import type { SourceFacts } from './types/source-facts.js';

// Starting a thread and loading TypeScript in it costs more than analysing a small project.
const PARALLEL_FROM_FILES = 600;
const MAXIMUM_WORKERS = 8;
const BATCH_SIZE = 16;

// Analyses files on worker threads. Results come back in file order, whichever thread finishes
// first.
async function analyzeInParallel(
  root: string,
  jsFiles: readonly string[],
  workerCount: number,
  analysisOptions: AnalysisOptions,
): Promise<SourceAnalysis[]> {
  const results = Array.from<SourceAnalysis>({ length: jsFiles.length });
  let next = 0;
  const workers: Worker[] = [];
  function drive(worker: Worker): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      function dispatch(): void {
        if (next >= jsFiles.length) return resolve();
        const first = next;
        next = Math.min(jsFiles.length, next + BATCH_SIZE);
        const request: BatchRequest = { batch: first, files: jsFiles.slice(first, next) };
        worker.postMessage(request);
      }
      worker.on('message', ({ batch, results: batchResults }: BatchReply) => {
        batchResults.forEach((result, offset) => (results[batch + offset] = result));
        dispatch();
      });
      worker.on('error', reject);
      worker.on('exit', (code: number) => reject(new Error('Analysis worker stopped with exit code ' + code)));
      dispatch();
    });
  }
  try {
    for (let index = 0; index < workerCount; index += 1) {
      const workerData: ScanWorkerData = { root, jsFiles, analysisOptions };
      workers.push(new Worker(path.join(import.meta.dirname, 'scan-worker.js'), { workerData }));
    }
    await Promise.all(workers.map(drive));
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
  return results;
}

// An unreadable file stops the scan immediately; an unparsable one comes back as a parseError for
// the caller to skip.
async function analyzeSequentially(
  root: string,
  jsFiles: readonly string[],
  analysisOptions: AnalysisOptions,
): Promise<SourceAnalysis[]> {
  const resolve = createResolver(root, new Set(jsFiles));
  const entries = await readSourceFiles(root, jsFiles);
  return jsFiles.map((file, index) =>
    analyzeSource(root, file, entries[index].text, resolve, { ...analysisOptions, disk: entries[index] }),
  );
}

function analyzeFiles(
  root: string,
  jsFiles: readonly string[],
  parallelFrom: number,
  analysisOptions: AnalysisOptions,
): Promise<SourceAnalysis[]> {
  const workerCount = Math.min(MAXIMUM_WORKERS, os.availableParallelism() - 1);
  return jsFiles.length >= parallelFrom && workerCount > 1
    ? analyzeInParallel(root, jsFiles, workerCount, analysisOptions)
    : analyzeSequentially(root, jsFiles, analysisOptions);
}

// parseError reads "file:line:column message"; the skipped file is listed once so the run can no
// longer look like a pass.
function reportUnparsable(skippedFiles: SkippedFile[], file: string, parseError: string): void {
  const reason = parseError.slice(file.length + 1);
  recordSkippedFile(skippedFiles, { file, reason }, `${parseError} Skipped that file, which does not parse.`);
}

function isAnalyzableSource(file: string): boolean {
  return /\.[cm]?[jt]sx?$/i.test(file) && !/\.d\.[cm]?ts$/i.test(file);
}

function isOtherSource(file: string): boolean {
  return Object.hasOwn(nonJsLanguages, path.extname(file).toLowerCase());
}

function sourceCoverage({
  inventory,
  jsFiles,
  otherSources,
  edges,
  placementRuleCount,
  inScope,
}: SourceCoverageInput): SourceCoverage {
  const discoveredFiles = inScope ? inventory.filter(inScope).length : inventory.length;
  const scripts = inScope ? jsFiles.filter(inScope) : jsFiles;
  const other = inScope ? otherSources.filter(inScope) : otherSources;
  const languageCounts: Record<string, number> = {};
  for (const file of scripts) {
    const language = /\.[cm]?tsx?$/i.test(file) ? 'TypeScript' : 'JavaScript';
    languageCounts[language] = (languageCounts[language] ?? 0) + 1;
  }
  for (const file of other) {
    const language = nonJsLanguages[path.extname(file).toLowerCase()];
    languageCounts[language] = (languageCounts[language] ?? 0) + 1;
  }
  return {
    discoveredFiles,
    scannedFiles: scripts.length + other.length,
    dependencyFiles: scripts.length,
    placementFiles: placementRuleCount ? discoveredFiles : 0,
    resolvedInternalEdges: inScope ? edges.filter((edge) => inScope(edge.from)).length : edges.length,
    languageCounts,
  };
}

// Declaration files are not analysed or reported, but what they import is still used.
async function declarationUsages(
  root: string,
  inventory: readonly string[],
  jsFiles: readonly string[],
  identifierIndex: Map<string, string> | undefined,
): Promise<ModuleUsage[]> {
  const declarations = inventory.filter((file) => /\.d\.[cm]?ts$/i.test(file));
  if (!declarations.length) return [];
  const resolve = createResolver(root, new Set(jsFiles), declarations);
  const entries = await readSourceFiles(root, declarations);
  return declarations.flatMap((file, index) => {
    const { text, utf16 } = entries[index];
    if (text === undefined) return [];
    if (identifierIndex && !utf16) identifierIndex.set(file, identifierIndexOf(text));
    const source = ts.createSourceFile(path.join(root, file), text, ts.ScriptTarget.Latest, true);
    return [collectModuleUsage(source, file, resolve)];
  });
}

function attachContextualReasons(
  findings: Finding[],
  snapshots: ReadonlySet<string>,
  generated: ReadonlySet<string>,
): void {
  for (const finding of findings) {
    const reason = finding.contextualReason || sourceContext(finding, snapshots, generated);
    if (reason) finding.contextualReason = reason;
  }
}

// The index serves private-method fixes, which only look outside a file when the package is
// private.
function createIdentifierIndex(root: string, wanted: boolean | undefined): Map<string, string> | undefined {
  return wanted && isPrivateManifest(path.join(root, 'package.json')) ? new Map<string, string>() : undefined;
}

function reportUnparsablePolyglot(skippedFiles: SkippedFile[], polyglot: Pick<PolyglotAnalysis, 'unparsable'>): void {
  for (const { file, parseError } of polyglot.unparsable) reportUnparsable(skippedFiles, file, parseError);
}

async function analyzeWithPolyglot(
  root: string,
  jsFiles: readonly string[],
  otherSources: readonly string[],
  parallelFrom: number,
  options: AnalysisOptions,
): Promise<{ analyses: SourceAnalysis[]; polyglot: PolyglotAnalysis }> {
  const polyglotPromise = analyzePolyglot({ root, files: otherSources });
  try {
    const analyses = await analyzeFiles(root, jsFiles, parallelFrom, options);
    return { analyses, polyglot: await polyglotPromise };
  } catch (error) {
    await polyglotPromise.catch(() => {});
    throw error;
  }
}

async function scan(
  root: string,
  policy: MaintainabilityPolicy,
  { parallelFrom = PARALLEL_FROM_FILES, inScope, indexIdentifiers }: ScanOptions = {},
): Promise<SourceScan> {
  const inventory = listFiles(root, policy.exclude, policy.isIgnored);
  const jsFiles = inventory.filter(isAnalyzableSource);
  const otherSources = inventory.filter(isOtherSource);
  let ignoredAllSources = false;
  if (!jsFiles.length && !otherSources.length && !policy.placement.length) {
    ignoredAllSources =
      Boolean(policy.isIgnored) &&
      listFiles(root, policy.exclude).some((file) => isAnalyzableSource(file) || isOtherSource(file));
    if (!ignoredAllSources) {
      throw new Error(
        'No supported source files or placement rules in this directory. Use --graph for a dependency graph from another language.',
      );
    }
  }
  const duplicates = createDuplicateIndex();
  const edges: ModuleEdge[] = [];
  const constEnums = new Map<string, string[]>();
  const usages: ModuleUsage[] = [];
  const findings: Finding[] = checkPlacement(inventory, policy.placement);
  const generated = new Set<string>();
  const skippedFiles: SkippedFile[] = [];
  const identifierIndex = createIdentifierIndex(root, indexIdentifiers);
  const fileFacts = new Map<string, SourceFacts>();
  const { analyses, polyglot } = await analyzeWithPolyglot(root, jsFiles, otherSources, parallelFrom, {
    dataAccess: policy.dataAccess,
    limits: policy.limits,
    indexIdentifiers: identifierIndex !== undefined,
  });
  for (const [index, file] of jsFiles.entries()) {
    const analysis = analyses[index];
    if (analysis.failure !== undefined) throw new Error(analysis.failure);
    fileFacts.set(file, analysis.facts);
    if (identifierIndex && analysis.facts.identifierIndex !== undefined)
      identifierIndex.set(file, analysis.facts.identifierIndex);
    if (analysis.parseError !== undefined) {
      reportUnparsable(skippedFiles, file, analysis.parseError);
      constEnums.set(file, []);
      usages.push(analysis.usage);
      continue;
    }
    if (analysis.generated) generated.add(file);
    duplicates.addExtracted(file, analysis.duplicates);
    for (const finding of analysis.findings) findings.push(finding);
    for (const edge of analysis.edges) edges.push(edge);
    constEnums.set(file, analysis.constEnums);
    usages.push(analysis.usage);
  }
  for (const finding of polyglot.findings) findings.push(finding);
  reportUnparsablePolyglot(skippedFiles, polyglot);
  for (const finding of duplicates.findings()) findings.push(finding);
  for (const finding of checkGraph({ files: jsFiles, edges, boundaries: policy.boundaries, constEnums }))
    findings.push(finding);
  const { isEntryPoint, isToolingFile, workspacePackages, isPrivateApplication, operatorScripts, siblingUsages } =
    createEntryPoints(root, inventory, jsFiles, fileFacts);
  const declarations = await declarationUsages(root, inventory, jsFiles, identifierIndex);
  for (const finding of checkUnusedModules({
    files: jsFiles,
    usages,
    declarations,
    isEntryPoint,
    isToolingFile,
    isPrivateApplication,
    workspacePackages,
    operatorScripts,
    siblingUsages,
  }))
    findings.push(finding);
  const snapshots = archivedCopies([...jsFiles, ...otherSources]);
  attachContextualReasons(findings, snapshots, generated);
  return {
    mode: 'source',
    ...sourceCoverage({
      inventory,
      jsFiles,
      otherSources,
      edges,
      placementRuleCount: policy.placement.length,
      inScope,
    }),
    findings,
    ...(skippedFiles.length && { skippedFiles }),
    ...(ignoredAllSources && { ignoredAllSources }),
    ...(identifierIndex && { identifierIndex }),
  };
}

export {
  scan,
  isAnalyzableSource,
  isOtherSource,
  reportUnparsable,
  reportUnparsablePolyglot,
  sourceCoverage,
  PARALLEL_FROM_FILES,
};
