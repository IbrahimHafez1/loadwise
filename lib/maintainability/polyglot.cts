import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { byLanguage, nonJsLanguages, rulesFor } from '../../polyglot/maintainability/rules.cjs';
import { createDuplicateIndex } from './polyglot-duplicates.cjs';
import { syntaxError, compatibilityMatch, retryCompatibility } from '../shared/polyglot-compatibility.cjs';
import type { AstGrepMatch } from '../performance/types/ast-grep-match.cjs';
import type { LocatedFinding } from './types/module-graph.cjs';
import type { DuplicateIndex, PolyglotAnalysis, SpannedMatch, UnparsableFile } from './types/polyglot-scan.cjs';
import * as postinstall from '@ast-grep/cli/postinstall.js';

// What one language's scan needs besides its files.
interface LanguageScan {
  language: string;
  rules: string;
}

interface ParserBatch extends LanguageScan {
  args: string[];
}

// Where a scan puts what it finds.
interface ScanSinks {
  findings: LocatedFinding[];
  duplicates: DuplicateIndex;
  unparsable: UnparsableFile[];
}

interface FileMatches {
  root: string;
  file: string;
  matches: AstGrepMatch[];
}

interface PolyglotRequest {
  root: string;
  files: readonly string[];
  includeDuplicates?: boolean;
}

function hasRangeEnd(match: AstGrepMatch): match is SpannedMatch {
  return 'end' in match.range;
}

const config = path.resolve(__dirname, '../../polyglot/maintainability/sgconfig.yml');
// Leave room for Windows quoting, the executable path, and the environment-independent command
// prefix.
const maxCommandUnits = 28000;
const maxFilesPerBatch = 400;

function parserPath(): string {
  let binary: string | undefined;
  try {
    binary = postinstall.resolveBinaryPath();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND')) throw error;
  }
  if (!binary)
    throw new Error(
      'Non-JavaScript checks require the optional @ast-grep/cli binary for this platform. Install with npm install --include=optional.',
    );
  return binary;
}

async function recordFileMatches(
  binary: string,
  { language, rules }: LanguageScan,
  { root, file, matches }: FileMatches,
  { findings, duplicates, unparsable }: ScanSinks,
): Promise<void> {
  let completeMatches: AstGrepMatch[] | undefined = matches;
  const error = matches.find(syntaxError);
  if (error) {
    completeMatches = await retryCompatibility(
      binary,
      config,
      async () => rules,
      path.resolve(root, file),
      matches.filter(compatibilityMatch),
    );
    if (!completeMatches) {
      const { line, column } = error.range.start;
      // A file the parser rejects is skipped and listed; it must not cost the report on the rest of
      // the project.
      unparsable.push({ file, parseError: `${file}:${line + 1}:${column + 1} ${error.message}` });
      return;
    }
  }
  for (const match of completeMatches) {
    if (compatibilityMatch(match)) continue;
    if (match.ruleId === 'duplicate-body-candidate') {
      if (hasRangeEnd(match)) duplicates.add(language, file, match);
    } else {
      const { line: row, column } = match.range.start;
      findings.push({ file, line: row + 1, column: column + 1, ruleId: match.ruleId, message: match.message });
    }
  }
}

async function scanBatch(
  binary: string,
  { args, language, rules }: ParserBatch,
  { root, files, findings, duplicates, unparsable }: ScanSinks & { root: string; files: readonly string[] },
): Promise<void> {
  const languageRules = byLanguage.get(language);
  if (!languageRules) throw new Error('Unsupported non-JavaScript language: ' + language);
  const { parser } = languageRules;
  const relative = (filename: string) => path.relative(root, path.resolve(root, filename)).split(path.sep).join('/');
  const expected = new Set(files);
  const scanned = new Set<string>();
  const matchesByFile = new Map<string, AstGrepMatch[]>();
  const unverified = new Map<string, string>();
  let failure: string | undefined;
  let summary = false;
  const child = spawn(binary, [...args, ...files], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  async function matches() {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      const match: AstGrepMatch = JSON.parse(line);
      const file = relative(match.file);
      if (!expected.has(file)) throw new Error('Unexpected parser result for ' + file);
      const fileMatches = matchesByFile.get(file) ?? [];
      fileMatches.push(match);
      matchesByFile.set(file, fileMatches);
    }
  }
  async function status() {
    for await (const line of createInterface({ input: child.stderr, crlfDelay: Infinity })) {
      const event = /^sg: entity\|file\|(.+): (?:language=(\w+),appliedRuleCount=(\d+)|skipped=(\w+))$/.exec(line);
      if (event) {
        const file = relative(event[1]);
        if (
          expected.has(file) &&
          ((event[2]?.toLowerCase() === parser.toLowerCase() && Number(event[3]) > 0) || event[4] === 'emptyFile')
        )
          scanned.add(file);
        else if (expected.has(file)) unverified.set(file, 'Could not verify this file with the ' + parser + ' parser.');
        else failure ||= 'Could not verify ' + file + ' with the ' + parser + ' parser.';
      } else if (line.startsWith('sg: summary|file: scannedFileCount=')) summary = true;
      else if (line.trim() && !line.startsWith('sg: ')) failure ||= line.trim();
    }
  }
  try {
    const [[code, signal]] = await Promise.all([once(child, 'close'), matches(), status()]);
    if (failure || code !== 0) throw new Error(failure || 'Parser failed: ' + (signal || code));
    if (!summary) throw new Error('Parser omitted its scan summary.');
    for (const file of expected)
      if (!scanned.has(file) && !unverified.has(file)) throw new Error('No parser result for ' + file);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    throw error;
  }
  // A file the parser cannot verify is skipped and listed, like one that does not parse, never
  // half-scanned.
  for (const [file, parseError] of unverified) unparsable.push({ file, parseError: `${file}: ${parseError}` });
  for (const [file, matches] of matchesByFile) {
    if (unverified.has(file)) continue;
    await recordFileMatches(binary, { language, rules }, { root, file, matches }, { findings, duplicates, unparsable });
  }
}

async function analyzePolyglot({ root, files, includeDuplicates = true }: PolyglotRequest): Promise<PolyglotAnalysis> {
  const groups = new Map<string, string[]>();
  for (const file of new Set(files)) {
    const language = nonJsLanguages[path.extname(file).toLowerCase()];
    if (!language) throw new Error('Unsupported non-JavaScript extension: ' + file);
    const languageFiles = groups.get(language) ?? [];
    languageFiles.push(file);
    groups.set(language, languageFiles);
  }
  const findings: LocatedFinding[] = [];
  const unparsable: UnparsableFile[] = [];
  const languageCounts: Record<string, number> = {};
  if (!groups.size) return { findings, languageCounts, unparsable };
  const binary = parserPath();
  const duplicates = createDuplicateIndex();
  for (const [language, inputs] of groups) {
    const rules = rulesFor(language, { includeDuplicates });
    const args = [
      'scan',
      '--config',
      config,
      '--inline-rules',
      rules,
      '--custom-languages',
      'ignore',
      '--json=stream',
      '--inspect=entity',
      '--',
    ];
    const used = [binary, ...args].reduce((size, argument) => size + argument.length * 2 + 3, 0);
    const budget = maxCommandUnits - used;
    let batch: string[] = [];
    let current = 0;
    for (const file of inputs) {
      const units = file.length * 2 + 3;
      if (units > budget) throw new Error('Input path exceeds the parser command size limit: ' + file);
      if (current + units > budget || batch.length === maxFilesPerBatch) {
        await scanBatch(binary, { args, language, rules }, { root, files: batch, findings, duplicates, unparsable });
        batch = [];
        current = 0;
      }
      batch.push(file);
      current += units;
    }
    await scanBatch(binary, { args, language, rules }, { root, files: batch, findings, duplicates, unparsable });
    languageCounts[language] = inputs.length;
  }
  for (const group of duplicates.findings()) findings.push(group);
  findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.ruleId.localeCompare(right.ruleId),
  );
  return { findings, languageCounts, unparsable };
}

export { analyzePolyglot, nonJsLanguages };
