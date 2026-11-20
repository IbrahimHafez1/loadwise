'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { createResolver } = require('./inputs.cjs');
const { readSources, analyzeSource } = require('./analyze-source.cjs');

const { root, jsFiles, analysisOptions } = workerData;
const resolve = createResolver(root, new Set(jsFiles));

// Each request is a batch of project-relative files; the reply keeps their order. A failure is reported
// per file so the caller can raise the first one in file order, as a single-threaded scan would.
parentPort.on('message', async ({ batch, files }) => {
  const texts = await readSources(root, files);
  const results = files.map((file, index) => {
    try {
      return analyzeSource(root, file, texts[index], resolve, analysisOptions);
    } catch (error) {
      return { failure: error instanceof Error ? error.message : String(error) };
    }
  });
  parentPort.postMessage({ batch, results });
});
