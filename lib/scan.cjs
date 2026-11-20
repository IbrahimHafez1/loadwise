'use strict';

const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { listFiles, createResolver } = require('./inputs.cjs');
const { createDuplicateIndex } = require('./duplicates.cjs');
const { archivedCopies, sourceContext } = require('./snapshot-context.cjs');
const { checkGraph } = require('./architecture.cjs');
const { checkPlacement } = require('./layout.cjs');
const { nonJsLanguages, analyzePolyglot } = require('./polyglot.cjs');
const { readSources, analyzeSource } = require('./analyze-source.cjs');

// Starting a thread and loading TypeScript in it costs more than analysing a small project.
const PARALLEL_FROM_FILES = 600;
const MAXIMUM_WORKERS = 8;
const BATCH_SIZE = 16;

// Analyses files on worker threads. Results come back in file order, whichever thread finishes first.
async function analyzeInParallel(root, jsFiles, workerCount) {
  const results = Array.from({ length: jsFiles.length });
  let next = 0;
  const workers = Array.from(
    { length: workerCount },
    () => new Worker(path.join(__dirname, 'scan-worker.cjs'), { workerData: { root, jsFiles } }),
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
async function analyzeSequentially(root, jsFiles) {
  const resolve = createResolver(root, new Set(jsFiles));
  const texts = await readSources(root, jsFiles);
  return jsFiles.map((file, index) => analyzeSource(root, file, texts[index], resolve));
}

function analyzeFiles(root, jsFiles, parallelFrom) {
  const workerCount = Math.min(MAXIMUM_WORKERS, os.availableParallelism() - 1);
  return jsFiles.length >= parallelFrom && workerCount > 1
    ? analyzeInParallel(root, jsFiles, workerCount)
    : analyzeSequentially(root, jsFiles);
}

async function scan(root, policy, { parallelFrom = PARALLEL_FROM_FILES } = {}) {
  const inventory = listFiles(root, policy.exclude);
  const jsFiles = inventory.filter((file) => /\.[cm]?[jt]sx?$/i.test(file) && !/\.d\.[cm]?ts$/i.test(file));
  const otherSources = inventory.filter((file) => Object.hasOwn(nonJsLanguages, path.extname(file).toLowerCase()));
  if (!jsFiles.length && !otherSources.length && !policy.placement.length) {
    throw new Error(
      'No supported source files or placement rules in this directory. Use --graph for a dependency graph from another language.',
    );
  }
  const duplicates = createDuplicateIndex();
  const edges = [];
  const findings = checkPlacement(inventory, policy.placement);
  const languageCounts = {};
  const generated = new Set();
  const analyses = await analyzeFiles(root, jsFiles, parallelFrom);
  for (const [index, file] of jsFiles.entries()) {
    const analysis = analyses[index];
    if (analysis.failure !== undefined) throw new Error(analysis.failure);
    if (analysis.generated) generated.add(file);
    languageCounts[analysis.language] = (languageCounts[analysis.language] ?? 0) + 1;
    duplicates.addExtracted(file, analysis.duplicates);
    for (const finding of analysis.findings) findings.push(finding);
    for (const edge of analysis.edges) edges.push(edge);
  }
  const polyglot = await analyzePolyglot({ root, files: otherSources });
  for (const finding of polyglot.findings) findings.push(finding);
  for (const finding of duplicates.findings()) findings.push(finding);
  for (const finding of checkGraph({ files: jsFiles, edges, boundaries: policy.boundaries })) findings.push(finding);
  const snapshots = archivedCopies([...jsFiles, ...otherSources]);
  for (const finding of findings) {
    const reason = finding.contextualReason || sourceContext(finding, snapshots, generated);
    if (reason) finding.contextualReason = reason;
  }
  return {
    mode: 'source',
    discoveredFiles: inventory.length,
    scannedFiles: jsFiles.length + otherSources.length,
    dependencyFiles: jsFiles.length,
    placementFiles: policy.placement.length ? inventory.length : 0,
    resolvedInternalEdges: edges.length,
    languageCounts: { ...languageCounts, ...polyglot.languageCounts },
    findings,
  };
}

module.exports = { scan };
