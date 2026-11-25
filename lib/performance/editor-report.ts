import fs from 'node:fs';
import path from 'node:path';
import { exampleFor as performanceExample } from '../../editor/performance-examples.cjs';
import { exampleFor as maintainabilityExample } from '../../editor/maintainability-examples.cjs';
import { exampleFor as securityExample } from '../../editor/security-examples.cjs';
import { hotPathLabel } from '../shared/hot-path.js';
import { getFindingComparison, inlineComparison } from '../../editor/finding-comparison.cjs';
import type { Finding } from '../shared/types.js';
import type { LineCache } from './types/editor-report.js';

const contractRules = new Set(['pg-transaction-on-pool', 'file-placement', 'folder-boundary', 'query-mutates-state']);
const languageIds: Record<string, string> = {
  js: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  jsx: 'javascriptreact',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescriptreact',
  py: 'python',
  go: 'go',
  java: 'java',
  cs: 'csharp',
  rs: 'rust',
  php: 'php',
  rb: 'ruby',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  sql: 'sql',
  prisma: 'prisma',
};
const scriptLanguages = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);
const lineBreak = '\u2028';
const controlCharacters = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const invalidFilename = /[\p{Cc}\p{Zl}\p{Zp}]| \| \d+ \| \d+ \| \d+ \| (?:error|warning) \| [a-z0-9-]+ \| /u;

function sourceExample(ruleId: string, languageId: string, message: string) {
  return performanceExample(ruleId, languageId, message) ?? securityExample(ruleId, languageId);
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function readLines(root: string, filename: string, cache: LineCache): string[] | undefined {
  if (cache.has(filename)) return cache.get(filename);
  let lines: string[] | undefined;
  try {
    const realFile = fs.realpathSync.native(filename);
    if (inside(fs.realpathSync.native(root), realFile) && fs.statSync(realFile).isFile()) {
      lines = fs
        .readFileSync(realFile, 'utf8')
        .replace(/^\uFEFF/, '')
        .split(/\r\n?|\n/);
    }
  } catch (error) {
    // A file can move between the scan and the report.
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (typeof code !== 'string' || !['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(code)) throw error;
  }
  cache.set(filename, lines);
  return lines;
}

function hasReportableIdentity(finding: Finding): finding is Finding & { file: string; message: string } {
  if (!finding || typeof finding.file !== 'string' || invalidFilename.test(finding.file)) return false;
  return (
    typeof finding.ruleId === 'string' && /^[a-z0-9-]+$/.test(finding.ruleId) && typeof finding.message === 'string'
  );
}

function findingPosition(finding: Finding): { line: number; column: number } | undefined {
  const { line, column } = finding;
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) return;
  if (typeof column !== 'number' || !Number.isSafeInteger(column) || column < 1) return;
  return { line, column };
}

function codeLines(label: string, code: string): string[] {
  return [label, ...code.split(/\r\n?|\n/).map((codeLine) => codeLine.replaceAll(controlCharacters, ' '))];
}

function messageParts(
  finding: Finding,
  message: string,
  example: ReturnType<typeof sourceExample>,
  comparison: ReturnType<typeof getFindingComparison>,
): string[] {
  const parts = [message];
  const preview = inlineComparison(comparison);
  if (preview) parts.unshift(preview);
  if (finding.contextualReason) parts.push(String(finding.contextualReason).replaceAll(controlCharacters, ' '));
  const hotPath = hotPathLabel(finding);
  if (hotPath) parts.push('Hot path: ' + hotPath);
  if (comparison) {
    const paired = comparison.kind === 'source';
    parts.push(...codeLines(paired ? 'Current code:' : 'Flagged line:', comparison.before));
    if (comparison.kind === 'review') {
      if (preview !== 'Review: ' + comparison.inline) parts.push(comparison.inline);
    } else parts.push(...codeLines(paired ? 'Suggested rewrite:' : 'Illustrative alternative:', comparison.after));
  } else if (example) parts.push(...codeLines('Illustrative alternative:', example.code));
  const note = comparison ? comparison.note : example?.note;
  if (note) parts.push(note.replaceAll(controlCharacters, ' '));
  return parts;
}

function formatFinding(
  root: string,
  source: string,
  finding: Finding,
  fileCache: LineCache = new Map(),
): string | undefined {
  if (source !== 'loadwise perf' && source !== 'loadwise maint') return;
  if (!hasReportableIdentity(finding)) return;
  const position = findingPosition(finding);
  if (!position) return;
  const { line, column } = position;
  const filename = path.resolve(root, finding.file);
  if (!inside(root, filename)) return;
  const lines = readLines(root, filename, fileCache);
  if (!lines) return;
  const text = lines[line - 1];
  if (text === undefined) return;
  const extension = path.extname(filename).slice(1).toLowerCase();
  const languageId = Object.hasOwn(languageIds, extension) ? languageIds[extension] : 'plaintext';
  let offset = Math.min(column - 1, text.length);
  // TypeScript uses UTF-16 columns. ast-grep counts Unicode code points.
  offset = toUtf16Offset(languageId, text, offset);
  const message = finding.message.replaceAll(controlCharacters, ' ');
  const diagnostic = {
    source,
    code: finding.ruleId,
    message,
    suggestion: finding.suggestion,
    comparison: finding.comparison,
    range: { start: { line: line - 1, character: offset } },
  };
  const document = {
    languageId,
    isDirty: false,
    lineCount: lines.length,
    lineAt: (index: number) => ({ text: lines[index] }),
  };
  // The perf watcher also reports security findings, so its lookup falls back to the security
  // examples.
  const lookup = source === 'loadwise perf' ? sourceExample : maintainabilityExample;
  const example = lookup(finding.ruleId, languageId, message);
  const comparison = getFindingComparison(document, diagnostic, example);
  const parts = messageParts(finding, message, example, comparison);
  const tokenLength = /^[\p{L}\p{N}_$]+/u.exec(text.slice(offset))?.[0].length ?? 1;
  return [
    'BACKEND_CHECKER',
    path.relative(root, filename),
    line,
    offset + 1,
    Math.min(offset + tokenLength, text.length) + 1,
    contractRules.has(finding.ruleId) ? 'error' : 'warning',
    finding.ruleId,
    parts.join(lineBreak),
  ].join(' | ');
}

function toUtf16Offset(languageId: string, text: string, offset: number): number {
  if (!scriptLanguages.has(languageId) && /[\uD800-\uDBFF]/.test(text.slice(0, offset))) {
    let remaining = offset;
    offset = 0;
    for (const character of text) {
      if (remaining === 0) break;
      offset += character.length;
      remaining--;
    }
  }
  return offset;
}

export { formatFinding };
