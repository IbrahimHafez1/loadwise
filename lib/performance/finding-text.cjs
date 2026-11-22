'use strict';

const { diffLines, labelledLines } = require('../shared/fix-terminal.cjs');
const path = require('node:path');
const { exampleFor } = require('../../editor/performance-examples.cjs');
const { exampleFor: securityExample } = require('../../editor/security-examples.cjs');
const { formatImpact } = require('./impact.cjs');
const { hotPathLabel } = require('../shared/hot-path.cjs');

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
  const example =
    languageId &&
    (exampleFor(finding.ruleId, languageId, finding.message) ?? securityExample(finding.ruleId, languageId));
  if (!example) return;
  const note = example.note ?? example.review;
  finding.example = { language: example.language, code: example.code, ...(note && { note }) };
}

function exampleLines(code) {
  const lines = code.split('\n');
  const shown = lines.length > maxFixLines ? [...lines.slice(0, maxFixLines - 1), '...'] : lines;
  return ['  Example (generic, adapt it to this code):', ...shown.map((line) => '    ' + line)];
}

function fixLines(fix) {
  const lines = [];
  for (const change of fix.changes) {
    if (change.create)
      lines.push(`  Fix (${change.file}, new file):`, ...change.after.split('\n').map((line) => '    + ' + line));
    else lines.push(`  Fix (${change.file}:${change.line}):`, ...diffLines(change.before, change.after));
  }
  if (fix.note) lines.push(...labelledLines('Note', fix.note));
  return lines;
}

// The id lets a reader apply or discuss one finding: `--fix --only <id>`.
function findingLabel({ ruleId, id }) {
  return id ? `[${ruleId} #${id}]` : `[${ruleId}]`;
}

// A report previews the fix as `--fix` writes it, which leaves out the why-comment unless `--comments` is given.
function previewFix({ fix, ruleId }) {
  return require('../shared/fix-presentation.cjs').withoutWhyComment(fix, ruleId);
}

// A suggestion is already the exact change for this site and is spelled out in the message.
const needsExample = (finding) => !finding.fix && finding.example && !finding.suggestion;

function findingDetailLines(finding, { example = true } = {}) {
  const lines = [];
  const impact = formatImpact(finding.impact);
  if (impact) lines.push('  ' + impact);
  const hotPath = hotPathLabel(finding);
  if (hotPath) lines.push(`  Hot path: ${hotPath} (${finding.hotPath.reason})`);
  if (finding.fix) lines.push(...fixLines(previewFix(finding)));
  else if (example && needsExample(finding)) lines.push(...exampleLines(finding.example.code));
  return lines;
}

const location = ({ file, line, column }) => `${file}:${line}:${column}`;
const contextSuffix = ({ contextualReason }) => (contextualReason ? ` (${contextualReason})` : '');

function printSingleFinding(finding, fixCommand, print) {
  print(
    `${location(finding)} ${findingLabel(finding)} ${finding.impactLevel}: ${finding.message}${contextSuffix(finding)}`,
  );
  for (const detail of findingDetailLines(finding)) print(detail);
  if (finding.fix?.requiresReview && fixCommand) {
    print(`  After individual review: ${fixCommand} --fix --only ${finding.id}`);
  }
}

// The shared reason once, then each location with its own details one level further in, and the rule's generic
// example once.
function printFindingGroup(group, fixCommand, print) {
  const [first] = group;
  print(`[${first.ruleId}] ${first.impactLevel}: ${first.message}${contextSuffix(first)} (${group.length} findings)`);
  for (const finding of group) {
    print(`  ${location(finding)}${finding.id ? ' #' + finding.id : ''}`);
    for (const detail of findingDetailLines(finding, { example: false })) print('  ' + detail);
    if (finding.fix?.requiresReview && fixCommand) {
      print(`    After individual review: ${fixCommand} --fix --only ${finding.id}`);
    }
  }
  const withExample = group.find(needsExample);
  if (withExample) for (const line of exampleLines(withExample.example.code)) print(line);
}

// The findings of a text report, each reason printed once for the findings that share it.
function printFindings(findings, fixCommand, print) {
  const { findingReason, groupByReason } = require('../shared/reason-groups.cjs');
  for (const group of groupByReason(findings, findingReason)) {
    if (group.length === 1) printSingleFinding(group[0], fixCommand, print);
    else printFindingGroup(group, fixCommand, print);
  }
}

module.exports = { attachExample, diffLines, findingDetailLines, findingLabel, printFindings };
