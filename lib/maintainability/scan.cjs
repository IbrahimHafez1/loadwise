'use strict';

const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { Worker } = require('node:worker_threads');
const { listFiles, createResolver } = require('./inputs.cjs');
const { createDuplicateIndex } = require('./duplicates.cjs');
const { archivedCopies, sourceContext } = require('./snapshot-context.cjs');
const { checkGraph } = require('./architecture.cjs');
const { createEntryPoints } = require('./entry-points.cjs');
const { checkUnusedModules } = require('./unused-modules.cjs');
const { collectModuleUsage } = require('./module-usage.cjs');
const { checkPlacement } = require('./layout.cjs');
const { nonJsLanguages, analyzePolyglot } = require('./polyglot.cjs');
const { readSources, analyzeSource } = require('./analyze-source.cjs');

// Starting a thread and loading TypeScript in it costs more than analysing a small project.
const PARALLEL_FROM_FILES = 600;
const MAXIMUM_WORKERS = 8;
const BATCH_SIZE = 16;

// Analyses files on worker threads. Results come back in file order, whichever thread finishes first.
async function analyzeInParallel(root, jsFiles, workerCount, analysisOptions) {
  const results = Array.from({ length: jsFiles.length });
  let next = 0;
  const workers = Array.from(
    { length: workerCount },
    () => new Worker(path.join(__dirname, 'scan-worker.cjs'), { workerData: { root, jsFiles, analysisOptions } }),
  );
  function drive(worker) {
    return new Promise((resolve, reject) => {
      function dispatch() {
        if (next >= jsFiles.length) return resolve();
        const first = next;
        next = Math.min(jsFiles.length, next + BATCH_SIZE);
        worker.postMessage({ batch: first, files: jsFiles.slice(first, next) });
      }
      worker.on('message', ({ batch, results: batchResults }) => {
        batchResults.forEach((result, offset) => (results[batch + offset] = result));
        dispatch();
      });
      worker.on('error', reject);
      worker.on('exit', (code) => reject(new Error('Analysis worker stopped with exit code ' + code)));
      dispatch();
    });
  }
  try {
    await Promise.all(workers.map(drive));
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
  return results;
}

// An unreadable or unparsable file stops the scan immediately.
async function analyzeSequentially(root, jsFiles, analysisOptions) {
  const resolve = createResolver(root, new Set(jsFiles));
  const texts = await readSources(root, jsFiles);
  return jsFiles.map((file, index) => analyzeSource(root, file, texts[index], resolve, analysisOptions));
}

function analyzeFiles(root, jsFiles, parallelFrom, analysisOptions) {
  const workerCount = Math.min(MAXIMUM_WORKERS, os.availableParallelism() - 1);
  return jsFiles.length >= parallelFrom && workerCount > 1
    ? analyzeInParallel(root, jsFiles, workerCount, analysisOptions)
    : analyzeSequentially(root, jsFiles, analysisOptions);
}

function reportUnparsable(parseError) {
  console.error(`Note: ${parseError} Skipped that file, which does not parse.`);
}

function isAnalyzableSource(file) {
  return /\.[cm]?[jt]sx?$/i.test(file) && !/\.d\.[cm]?ts$/i.test(file);
}

function isOtherSource(file) {
  return Object.hasOwn(nonJsLanguages, path.extname(file).toLowerCase());
}

function sourceCoverage(inventory, jsFiles, otherSources, edges, hasPlacement, inScope) {
  const discoveredFiles = inScope ? inventory.filter(inScope).length : inventory.length;
  const scripts = inScope ? jsFiles.filter(inScope) : jsFiles;
  const other = inScope ? otherSources.filter(inScope) : otherSources;
  const languageCounts = {};
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
    placementFiles: hasPlacement ? discoveredFiles : 0,
    resolvedInternalEdges: inScope ? edges.filter((edge) => inScope(edge.from)).length : edges.length,
    languageCounts,
  };
}

// Declaration files are not analysed or reported, but what they import is still used.
async function declarationUsages(root, inventory, jsFiles) {
  const declarations = inventory.filter((file) => /\.d\.[cm]?ts$/i.test(file));
  if (!declarations.length) return [];
  const resolve = createResolver(root, new Set(jsFiles), declarations);
  const texts = await readSources(root, declarations);
  return declarations.flatMap((file, index) => {
    if (texts[index] === undefined) return [];
    const source = ts.createSourceFile(path.join(root, file), texts[index], ts.ScriptTarget.Latest, true);
    return [collectModuleUsage(source, file, resolve)];
  });
}

async function scan(root, policy, { parallelFrom = PARALLEL_FROM_FILES, inScope } = {}) {
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
  const edges = [];
  const constEnums = new Map();
  const usages = [];
  const findings = checkPlacement(inventory, policy.placement);
  const generated = new Set();
  const analyses = await analyzeFiles(root, jsFiles, parallelFrom, {
    dataAccess: policy.dataAccess,
    limits: policy.limits,
  });
  for (const [index, file] of jsFiles.entries()) {
    const analysis = analyses[index];
    if (analysis.failure !== undefined) throw new Error(analysis.failure);
    if (analysis.parseError !== undefined) {
      reportUnparsable(analysis.parseError);
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
  const polyglot = await analyzePolyglot({ root, files: otherSources });
  for (const finding of polyglot.findings) findings.push(finding);
  for (const finding of duplicates.findings()) findings.push(finding);
  for (const finding of checkGraph({ files: jsFiles, edges, boundaries: policy.boundaries, constEnums }))
    findings.push(finding);
  const { isEntryPoint, isToolingFile, workspacePackages, isPrivateApplication, operatorScripts } = createEntryPoints(
    root,
    inventory,
    jsFiles,
  );
  const declarations = await declarationUsages(root, inventory, jsFiles);
  for (const finding of checkUnusedModules({
    files: jsFiles,
    usages,
    declarations,
    isEntryPoint,
    isToolingFile,
    isPrivateApplication,
    workspacePackages,
    operatorScripts,
  }))
    findings.push(finding);
  const snapshots = archivedCopies([...jsFiles, ...otherSources]);
  for (const finding of findings) {
    const reason = finding.contextualReason || sourceContext(finding, snapshots, generated);
    if (reason) finding.contextualReason = reason;
  }
  return {
    mode: 'source',
    ...sourceCoverage(inventory, jsFiles, otherSources, edges, policy.placement.length, inScope),
    findings,
    ...(ignoredAllSources && { ignoredAllSources }),
  };
}

module.exports = { scan, isAnalyzableSource, isOtherSource, reportUnparsable, sourceCoverage, PARALLEL_FROM_FILES };
