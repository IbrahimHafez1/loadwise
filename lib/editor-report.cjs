'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { exampleFor: performanceExample } = require('../editor/performance-examples.cjs');
const { exampleFor: maintainabilityExample } = require('../editor/maintainability-examples.cjs');
const { getFindingComparison, inlineComparison } = require('../editor/finding-comparison.cjs');

const contractRules = new Set([
  'pg-transaction-on-pool',
  'data-access-boundary',
  'file-placement',
  'folder-boundary',
  'query-mutates-state',
]);
const languageIds = {
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
};
const scriptLanguages = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);
const lineBreak = '\u2028';
const controlCharacters = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const invalidFilename = /[\p{Cc}\p{Zl}\p{Zp}]| \| \d+ \| \d+ \| \d+ \| (?:error|warning) \| [a-z0-9-]+ \| /u;

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function readLines(root, filename, cache) {
  if (cache.has(filename)) return cache.get(filename);
  let lines;
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
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
  }
  cache.set(filename, lines);
  return lines;
}

function formatFinding(root, source, finding, fileCache = new Map()) {
  if (source !== 'backend-perf-check' && source !== 'maintainability-check') return;
  if (!finding || typeof finding.file !== 'string' || invalidFilename.test(finding.file)) return;
  if (typeof finding.ruleId !== 'string' || !/^[a-z0-9-]+$/.test(finding.ruleId) || typeof finding.message !== 'string')
    return;
  if (
    !Number.isSafeInteger(finding.line) ||
    finding.line < 1 ||
    !Number.isSafeInteger(finding.column) ||
    finding.column < 1
  )
    return;
  const filename = path.resolve(root, finding.file);
  if (!inside(root, filename)) return;
  const lines = readLines(root, filename, fileCache);
  const text = lines?.[finding.line - 1];
  if (text === undefined) return;
  const extension = path.extname(filename).slice(1).toLowerCase();
  const languageId = Object.hasOwn(languageIds, extension) ? languageIds[extension] : 'plaintext';
  let offset = Math.min(finding.column - 1, text.length);
  // TypeScript uses UTF-16 columns. ast-grep counts Unicode code points.
  if (!scriptLanguages.has(languageId) && /[\uD800-\uDBFF]/.test(text.slice(0, offset))) {
    let remaining = offset;
    offset = 0;
    for (const character of text) {
      if (remaining === 0) break;
      offset += character.length;
      remaining--;
    }
  }
  const message = finding.message.replace(controlCharacters, ' ');
  const diagnostic = {
    source,
    code: finding.ruleId,
    message,
    suggestion: finding.suggestion,
    comparison: finding.comparison,
    range: { start: { line: finding.line - 1, character: offset } },
  };
  const document = { languageId, lineCount: lines.length, lineAt: (index) => ({ text: lines[index] }) };
  const lookup = source === 'backend-perf-check' ? performanceExample : maintainabilityExample;
  const example = lookup(finding.ruleId, languageId, message);
  const comparison = getFindingComparison(document, diagnostic, example);
  const parts = [message];
  const preview = inlineComparison(comparison);
  if (preview) parts.unshift(preview);
  if (finding.contextualReason) parts.push(String(finding.contextualReason).replace(controlCharacters, ' '));
  function appendCode(label, code) {
    parts.push(label, ...code.split(/\r\n?|\n/).map((line) => line.replace(controlCharacters, ' ')));
  }
  if (comparison) {
    const paired = comparison.kind === 'source';
    appendCode(paired ? 'Current code:' : 'Flagged line:', comparison.before);
    if (comparison.kind === 'review') {
      if (preview !== 'Review: ' + comparison.inline) parts.push(comparison.inline);
    } else appendCode(paired ? 'Suggested rewrite:' : 'Illustrative alternative:', comparison.after);
  } else if (example) appendCode('Illustrative alternative:', example.code);
  const note = comparison ? comparison.note : example?.note;
  if (note) parts.push(note.replace(controlCharacters, ' '));
  const tokenLength = /^[\p{L}\p{N}_$]+/u.exec(text.slice(offset))?.[0].length ?? 1;
  return [
    'BACKEND_CHECKER',
    path.relative(root, filename),
    finding.line,
    offset + 1,
    Math.min(offset + tokenLength, text.length) + 1,
    contractRules.has(finding.ruleId) ? 'error' : 'warning',
    finding.ruleId,
    parts.join(lineBreak),
  ].join(' | ');
}

module.exports = { formatFinding };
