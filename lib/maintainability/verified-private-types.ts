import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { ParsedCommandLine } from 'typescript';
import type { Finding, FixChange } from '../shared/types.js';

const recipe = 'verified-private-types';
// One baseline plus at most three batch trials. An unrecognised diagnostic withholds the batch.
const maxTrials = 3;
const entryFields = ['workspaces', 'main', 'module', 'browser', 'bin', 'exports', 'types', 'typings', 'typesVersions'];
const fileKey = (file: string): string =>
  ts.sys.useCaseSensitiveFileNames ? path.resolve(file) : path.resolve(file).toLowerCase();

// A manifest that is missing or malformed means the project cannot be verified, not that the scan
// should crash.
interface PackageManifest {
  private?: unknown;
  version?: string;
  [field: string]: unknown;
}

interface PrivateTypeCandidate {
  finding: Finding;
  file: string;
  index: number;
  after: string;
  change: FixChange;
}

function readJsonFile(file: string): PackageManifest | undefined {
  const text = ts.sys.readFile(file);
  if (!text) return;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function compilerConfig(directory: string): ParsedCommandLine | undefined {
  if (
    ['pnpm-workspace.yaml', 'pnpm-workspace.yml', 'lerna.json'].some((file) =>
      ts.sys.fileExists(path.join(directory, file)),
    )
  )
    return;
  const application = readJsonFile(path.join(directory, 'package.json'));
  if (!application) return;
  if (application.private !== true || entryFields.some((field) => field in application)) return;
  const filename = ['tsconfig.typecheck.json', 'tsconfig.json']
    .map((name) => path.join(directory, name))
    .find(ts.sys.fileExists);
  if (!filename) return;
  const options = { noEmit: true, noCheck: false, declaration: true };
  const config = ts.getParsedCommandLineOfConfigFile(filename, options, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic() {},
  });
  if (!config || config.projectReferences?.length || config.errors.length) return;
  // TS6 made ambient @types opt-in. Match a TS5 project's defaults using its installed version
  // metadata.
  const installed = readJsonFile(path.join(directory, 'node_modules/typescript/package.json'));
  if (installed && parseInt(installed.version ?? '', 10) < 6 && parseInt(ts.version, 10) === 6) {
    config.options.types ??= ['*'];
    config.options.ignoreDeprecations = '6.0';
  }
  return config;
}

function inspectCandidate(
  finding: Finding,
  directory: string,
  rootFiles: ReadonlySet<string>,
  sources: Map<string, string[]>,
): PrivateTypeCandidate | undefined {
  if (finding.file === undefined || finding.line === undefined) return;
  const absolute = path.resolve(directory, finding.file);
  const relative = path.relative(directory, fs.realpathSync(absolute));
  const file = fileKey(absolute);
  if (!relative || path.isAbsolute(relative) || relative.startsWith('..' + path.sep) || !rootFiles.has(file)) return;
  if (!sources.has(file)) sources.set(file, fs.readFileSync(absolute, 'utf8').split('\n'));
  const index = finding.line - 1;
  const before = sources.get(file)?.[index]?.replace(/\r$/, '');
  if (before === undefined) return;
  const declaration = /^(\s*)export (?:type|interface) ([$\w]+)/.exec(before);
  if (!declaration || declaration[2] !== finding.exportName) return;
  const after = before.replace(/^(\s*)export /, '$1');
  return { finding, file, index, after, change: { file: finding.file, line: finding.line, before, after } };
}

function diagnose(
  config: ParsedCommandLine,
  candidates: readonly PrivateTypeCandidate[],
  sources: ReadonlyMap<string, string[]>,
) {
  const lines = new Map<string, string[]>();
  for (const { file, index, after } of candidates) {
    let fileLines = lines.get(file);
    if (!fileLines) {
      fileLines = [...(sources.get(file) ?? [])];
      lines.set(file, fileLines);
    }
    const original = fileLines[index];
    fileLines[index] = after + (original.endsWith('\r') ? '\r' : '');
  }
  const overlays = new Map([...lines].map(([file, content]) => [file, content.join('\n')]));
  const host = ts.createCompilerHost(config.options);
  const originalRead = host.readFile;
  host.readFile = (file) => overlays.get(fileKey(file)) ?? originalRead(file);
  const program = ts.createProgram(config.fileNames, config.options, host);
  return ts.getPreEmitDiagnostics(program).filter((issue) => issue.category === ts.DiagnosticCategory.Error);
}

function attachVerifiedPrivateTypes(findings: Finding[], directory: string) {
  const proposed = findings.filter(
    (finding: Finding) => finding.suggestedRecipe === recipe && !finding.fix && !finding.contextualReason,
  );
  if (!proposed.length) return findings;
  const config = compilerConfig(directory);
  if (!config) {
    console.error(
      'Private type verification requires a private single application with a readable TypeScript configuration.',
    );
    return findings;
  }
  const roots = new Set(config.fileNames.map(fileKey));
  const sources = new Map<string, string[]>();
  let candidates = proposed
    .map((finding: Finding) => inspectCandidate(finding, directory, roots, sources))
    .filter((candidate): candidate is PrivateTypeCandidate => candidate !== undefined);
  if (!candidates.length) return findings;
  const baseline = diagnose(config, [], sources);
  if (baseline.length) {
    console.error(
      `Private type verification skipped: baseline TypeScript check returned TS${baseline[0].code}. ${ts.flattenDiagnosticMessageText(baseline[0].messageText, ' ')}`,
    );
    return findings;
  }
  for (let trial = 0; trial < maxTrials && candidates.length; trial++) {
    const errors = diagnose(config, candidates, sources);
    if (!errors.length) {
      for (const { finding, change } of candidates) {
        finding.fix = {
          requiresReview: true,
          changes: [change],
          note: 'This batch passed the application’s TypeScript and declaration checks in memory. Confirm external users do not import the type before removing its export.',
        };
        finding.fixable = true;
      }
      break;
    }
    const messages = errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, ' '));
    const remaining = candidates.filter(
      ({ finding }) => !messages.some((message) => message.includes("'" + finding.exportName + "'")),
    );
    if (remaining.length === candidates.length) break;
    candidates = remaining;
  }
  return findings;
}

export { attachVerifiedPrivateTypes };
