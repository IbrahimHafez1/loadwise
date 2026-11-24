import { diffLines, labelledLines } from '../shared/fix-terminal.cjs';
import path from 'node:path';
import { exampleFor } from '../../editor/performance-examples.cjs';
import { exampleFor as securityExample } from '../../editor/security-examples.cjs';
import { formatImpact } from './impact.cjs';
import { hotPathLabel } from '../shared/hot-path.cjs';
import type { Finding, FindingFix } from '../shared/types.cjs';
import { findingReason, groupByReason } from '../shared/reason-groups.cjs';

interface FindingExample {
  language: string;
  code: string;
  note?: string;
}

type PrintLine = (line: string) => void;

// Terminal output stays scannable; the full example is always in the JSON report.
const maxFixLines = 8;
const exampleLanguages: Record<string, string> = {
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

function attachExample(finding: Finding): void {
  if (finding.example || typeof finding.file !== 'string') return;
  const languageId = exampleLanguages[path.extname(finding.file).slice(1).toLowerCase()];
  const example =
    languageId &&
    (exampleFor(finding.ruleId, languageId, finding.message) ?? securityExample(finding.ruleId, languageId));
  if (!example) return;
  const note = example.note ?? example.review;
  finding.example = { language: example.language, code: example.code, ...(note && { note }) };
}

function exampleLines(code: string): string[] {
  const lines = code.split('\n');
  const shown = lines.length > maxFixLines ? [...lines.slice(0, maxFixLines - 1), '...'] : lines;
  return ['  Example (generic, adapt it to this code):', ...shown.map((line) => '    ' + line)];
}

function fixLines(fix: FindingFix): string[] {
  const lines: string[] = [];
  for (const change of fix.changes) {
    if (change.create)
      lines.push(`  Fix (${change.file}, new file):`, ...change.after.split('\n').map((line) => '    + ' + line));
    else lines.push(`  Fix (${change.file}:${change.line}):`, ...diffLines(change.before, change.after));
  }
  if (fix.note) lines.push(...labelledLines('Note', fix.note));
  return lines;
}

// The id lets a reader apply or discuss one finding: `--fix --only <id>`.
function findingLabel({ ruleId, id }: Pick<Finding, 'ruleId' | 'id'>): string {
  return id ? `[${ruleId} #${id}]` : `[${ruleId}]`;
}

// A suggestion is already the exact change for this site and is spelled out in the message.
const needsExample = (finding: Finding): finding is Finding & { example: FindingExample } =>
  !finding.fix && Boolean(finding.example) && !finding.suggestion;

function findingDetailLines(finding: Finding, { example = true } = {}): string[] {
  const lines: string[] = [];
  const impact = formatImpact(finding.impact);
  if (impact) lines.push('  ' + impact);
  const hotPath = hotPathLabel(finding);
  if (hotPath) lines.push(`  Hot path: ${hotPath} (${finding.hotPath?.reason})`);
  if (finding.fix) lines.push(...fixLines(finding.fix));
  else if (example && needsExample(finding)) lines.push(...exampleLines(finding.example.code));
  return lines;
}

const location = ({ file, line, column }: Pick<Finding, 'file' | 'line' | 'column'>) => `${file}:${line}:${column}`;
const contextSuffix = ({ contextualReason }: Pick<Finding, 'contextualReason'>) =>
  contextualReason ? ` (${contextualReason})` : '';

function printSingleFinding(finding: Finding, fixCommand: string | undefined, print: PrintLine): void {
  print(
    `${location(finding)} ${findingLabel(finding)} ${finding.impactLevel}: ${finding.message}${contextSuffix(finding)}`,
  );
  for (const detail of findingDetailLines(finding)) print(detail);
  if (finding.fix?.requiresReview && fixCommand) {
    print(`  After individual review: ${fixCommand} --fix --only ${finding.id}`);
  }
}

// The shared reason once, then each location with its own details one level further in, and the
// rule's generic example once.
function printFindingGroup(group: Finding[], fixCommand: string | undefined, print: PrintLine): void {
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
function printFindings(findings: Finding[], fixCommand: string | undefined, print: PrintLine): void {
  for (const group of groupByReason(findings, findingReason)) {
    if (group.length === 1) printSingleFinding(group[0], fixCommand, print);
    else printFindingGroup(group, fixCommand, print);
  }
}

export { attachExample, diffLines, findingDetailLines, findingLabel, printFindings };
