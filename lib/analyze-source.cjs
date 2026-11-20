'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { extractImplementations, generatedSource } = require('./duplicates.cjs');
const { analyzeFunctions } = require('./functions.cjs');
const { collectEdges } = require('./architecture.cjs');

const READ_CONCURRENCY = 64;

// Synchronous opens are slow on Windows; overlapping them hides most of that latency.
async function readSources(root, files) {
  const texts = Array.from({ length: files.length });
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const index = next++;
      const filename = path.join(root, files[index]);
      try {
        const buffer = await fs.promises.readFile(filename);
        // ts.sys.readFile owns UTF-16 detection; keep its decoding for those rare files.
        const utf16 = (buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff);
        texts[index] = utf16 ? ts.sys.readFile(filename) : buffer.toString('utf8').replace(/^\uFEFF/, '');
      } catch {
        texts[index] = undefined;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, worker));
  return texts;
}

// Everything computed from one source file, as plain data so it can cross a thread boundary.
function analyzeSource(root, file, text, resolve) {
  if (text === undefined) throw new Error('Unable to read source: ' + file);
  const filename = path.join(root, file);
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const [error] = source.parseDiagnostics;
  if (error) {
    const where = source.getLineAndCharacterOfPosition(error.start ?? 0);
    throw new Error(
      file +
        ':' +
        (where.line + 1) +
        ':' +
        (where.character + 1) +
        ' ' +
        ts.flattenDiagnosticMessageText(error.messageText, '\n'),
    );
  }
  return {
    generated: Boolean(generatedSource(source, file)),
    language: /\.[cm]?tsx?$/i.test(file) ? 'TypeScript' : 'JavaScript',
    duplicates: extractImplementations(source, file),
    findings: analyzeFunctions(source, file),
    edges: collectEdges(source, file, resolve, resolve.optionsFor(filename)),
  };
}

module.exports = { readSources, analyzeSource };
