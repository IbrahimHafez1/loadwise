import { parentPort, workerData } from 'node:worker_threads';
import { createResolver } from './inputs.js';
import { readSourceFiles, analyzeSource } from './analyze-source.js';
import type { SourceAnalysis } from './types/source-analysis.js';
import type { BatchReply, BatchRequest, ScanWorkerData } from './types/scan-worker.js';

const { root, jsFiles, analysisOptions }: ScanWorkerData = workerData;
if (!parentPort) throw new Error('scan-worker must run as a worker thread.');
const port = parentPort;
const resolve = createResolver(root, new Set(jsFiles));

// Each request is a batch of project-relative files; the reply keeps their order. A failure is
// reported per file so the caller can raise the first one in file order, as a single-threaded scan
// would.
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A rejection in an async listener would crash the worker without a reply, so any failure outside
// the per-file analysis is reported for every file of the batch instead.
port.on('message', async ({ batch, files }: BatchRequest) => {
  try {
    const entries = await readSourceFiles(root, files);
    const results = files.map((file, index): SourceAnalysis => {
      try {
        return analyzeSource(root, file, entries[index].text, resolve, { ...analysisOptions, disk: entries[index] });
      } catch (error) {
        return { failure: describeFailure(error) };
      }
    });
    const reply: BatchReply = { batch, results };
    port.postMessage(reply);
  } catch (error) {
    const reply: BatchReply = {
      batch,
      results: files.map((): SourceAnalysis => ({ failure: describeFailure(error) })),
    };
    port.postMessage(reply);
  }
});
