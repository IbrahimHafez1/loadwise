import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { extractImplementations, generatedSource } from './duplicates.js';
import { analyzeFunctions } from './functions.js';
import { collectEdges, exportedConstEnums } from './architecture.js';
import { checkDataAccess } from './data-access.js';
import { checkSizeLimits } from './size-limits.js';
import { collectModuleUsage } from './module-usage.js';
import { sourceFacts } from './source-facts.js';
import { checkUnusedBindings } from './unused-bindings.js';
import { checkStrayConsole } from './stray-console.js';
import { checkDeprecatedApis } from './deprecated-apis.js';
import { checkTypeSafetyHygiene } from './type-safety-hygiene.js';
import type {
  DiskFacts,
  AnalysisOptions,
  AnalyzedSource,
  SourceRead,
  UnparsableSource,
} from './types/source-analysis.js';
import type { ModuleResolver } from './types/module-resolver.js';

const READ_CONCURRENCY = 64;

// Synchronous opens are slow on Windows; overlapping them hides most of that latency.
async function readSourceFiles(root: string, files: readonly string[]): Promise<SourceRead[]> {
  const entries = Array.from<SourceRead>({ length: files.length });
  let next = 0;
  async function worker(): Promise<void> {
    while (next < files.length) {
      const index = next++;
      const filename = path.join(root, files[index]);
      try {
        const buffer = await fs.promises.readFile(filename);
        // ts.sys.readFile owns UTF-16 detection; keep its decoding for those rare files.
        const utf16 = (buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff);
        const text = utf16 ? ts.sys.readFile(filename) : buffer.toString('utf8').replace(/^\uFEFF/, '');
        entries[index] = { text, size: buffer.length, utf16 };
      } catch {
        entries[index] = { text: undefined };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, worker));
  return entries;
}

async function readSources(root: string, files: readonly string[]): Promise<(string | undefined)[]> {
  return (await readSourceFiles(root, files)).map((entry) => entry.text);
}

// Everything computed from one source file, as plain data so it can cross a thread boundary.
// `options.disk` is the file's byte size and whether it was UTF-16, which later steps need to treat
// it as the disk does.
function analyzeSource(
  root: string,
  file: string,
  text: string | undefined,
  resolve: ModuleResolver,
  options: AnalysisOptions = {},
): UnparsableSource | AnalyzedSource {
  const { dataAccess, limits } = options;
  if (text === undefined) throw new Error('Unable to read source: ' + file);
  const disk: DiskFacts = options.disk?.size === undefined ? { size: Buffer.byteLength(text) } : options.disk;
  const filename = path.join(root, file);
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const [error] = source.parseDiagnostics ?? [];
  if (error) {
    const where = source.getLineAndCharacterOfPosition(error.start ?? 0);
    // One broken file, such as a deliberately invalid fixture, must not cost the report on the rest
    // of the project. Its imports are still read from the recovered tree, so the modules it uses
    // are not reported as unused.
    return {
      parseError:
        file +
        ':' +
        (where.line + 1) +
        ':' +
        (where.character + 1) +
        ' ' +
        ts.flattenDiagnosticMessageText(error.messageText, '\n'),
      usage: collectModuleUsage(source, file, resolve),
      facts: sourceFacts(source, text, disk, options),
    };
  }
  const compilerOptions = resolve.optionsFor(filename);
  const accessFindings = dataAccess ? checkDataAccess(source, file, resolve, dataAccess, compilerOptions) : [];
  const generated = Boolean(generatedSource(source, file));
  const usage = collectModuleUsage(source, file, resolve);
  // Bundled output loads files by computed paths that say nothing about the project's own code.
  if (generated) usage.dynamicUnresolved = [];
  return {
    generated,
    duplicates: extractImplementations(source, file, generated),
    findings: [
      ...analyzeFunctions(source, file),
      ...accessFindings,
      ...checkSizeLimits(source, file, limits, generated),
      ...checkUnusedBindings(source, file, compilerOptions ?? {}),
      ...checkStrayConsole(source, file, compilerOptions ?? {}),
      ...checkDeprecatedApis(source, file),
      ...checkTypeSafetyHygiene(source, file),
    ],
    edges: collectEdges(source, file, resolve, compilerOptions),
    constEnums: exportedConstEnums(source),
    usage,
    facts: sourceFacts(source, text, disk, options),
  };
}

export { readSources, readSourceFiles, analyzeSource };
