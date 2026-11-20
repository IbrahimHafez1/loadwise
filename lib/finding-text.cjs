'use strict';

const path = require('node:path');
const { exampleFor } = require('../editor/performance-examples.cjs');
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

function fixLines(code) {
  const lines = code.split('\n');
  const shown = lines.length > maxFixLines ? [...lines.slice(0, maxFixLines - 1), '...'] : lines;
  return ['  Fix:', ...shown.map((line) => '    ' + line)];
}

function findingDetailLines(finding) {
  const lines = [];
  const impact = formatImpact(finding.impact);
  if (impact) lines.push('  ' + impact);
  if (finding.example) lines.push(...fixLines(finding.example.code));
  return lines;
}

module.exports = { attachExample, findingDetailLines };
