'use strict';

const path = require('node:path');
const { exampleFor } = require('../../editor/performance-examples.cjs');
const { formatImpact } = require('./impact.cjs');

// Terminal output stays scannable; the full example is always in the JSON report.
const maxFixLines = 8;
const exampleLanguages = {
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
};

function attachExample(finding) {
  if (finding.example || typeof finding.file !== 'string') return;
  const languageId = exampleLanguages[path.extname(finding.file).slice(1).toLowerCase()];
  const example = languageId && exampleFor(finding.ruleId, languageId, finding.message);
  if (!example) return;
  const note = example.note ?? example.review;
  finding.example = { language: example.language, code: example.code, ...(note && { note }) };
}

function exampleLines(code) {
  const lines = code.split('\n');
  const shown = lines.length > maxFixLines ? [...lines.slice(0, maxFixLines - 1), '...'] : lines;
  return ['  Example (generic, adapt it to this code):', ...shown.map((line) => '    ' + line)];
}

function indentationWidth(line) {
  return /^[ \t]*/.exec(line)[0].length;
}

// Unchanged lines at either end print as context, so the reader sees exactly which lines change.
function diffLines(before, after) {
  const removed = before.split('\n');
  const added = after.split('\n');
  let prefix = 0;
  while (prefix < removed.length && prefix < added.length && removed[prefix] === added[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < removed.length - prefix &&
    suffix < added.length - prefix &&
    removed.at(-1 - suffix) === added.at(-1 - suffix)
  )
    suffix++;
  const rows = [
    ...removed.slice(0, prefix).map((line) => ['  ', line]),
    ...removed.slice(prefix, removed.length - suffix).map((line) => ['- ', line]),
    ...added.slice(prefix, added.length - suffix).map((line) => ['+ ', line]),
    ...removed.slice(removed.length - suffix).map((line) => ['  ', line]),
  ];
  const indentation = Math.min(...rows.filter(([, line]) => line.trim()).map(([, line]) => indentationWidth(line)));
  return rows.map(([marker, line]) => '    ' + marker + line.slice(indentation));
}

function fixLines(fix) {
  const lines = [];
  for (const change of fix.changes) {
    if (change.create)
      lines.push(`  Fix (${change.file}, new file):`, ...change.after.split('\n').map((line) => '    + ' + line));
    else lines.push(`  Fix (${change.file}:${change.line}):`, ...diffLines(change.before, change.after));
  }
  if (fix.note) lines.push('  Note: ' + fix.note);
  return lines;
}

// The id lets a reader apply or discuss one finding: `--fix --only <id>`.
function findingLabel({ ruleId, id }) {
  return id ? `[${ruleId} #${id}]` : `[${ruleId}]`;
}

function findingDetailLines(finding) {
  const lines = [];
  const impact = formatImpact(finding.impact);
  if (impact) lines.push('  ' + impact);
  if (finding.fix) lines.push(...fixLines(finding.fix));
  // A suggestion is already the exact change for this site and is spelled out in the message.
  else if (finding.example && !finding.suggestion) lines.push(...exampleLines(finding.example.code));
  return lines;
}

module.exports = { attachExample, diffLines, findingDetailLines, findingLabel };
