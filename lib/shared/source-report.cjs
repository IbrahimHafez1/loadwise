// @ts-check
'use strict';

// The report of a source checker (perf or sec): finding ids, contextual selection, changed-line filtering, site
// fixes and examples, then text or JSON output and the exit code. `pillar` is { command, contractRules }: the
// loadwise subcommand printed in fix commands and the rule ids that `--fail-on contract` enforces.
const path = require('node:path');
const { quoteArgument } = require('./shell-argument.cjs');
const { filterMinImpact, sortByImpactWithinFiles } = require('./impact-levels.cjs');
const { applyBaselineOptions, baselineNoteLines } = require('./baseline.cjs');
const { resolveFormat, renderReports } = require('./formats/index.cjs');
const { impactByRule } = require('../security/rule-ids.cjs');

// Ids hash paths relative to the project root, so they match whichever folder the check runs from.
function findingRoot(project) {
  return require('../performance/schema/context.cjs').findProjectRoot(path.resolve(project ?? '.'));
}

function assignFindingIds(findings, root) {
  require('../performance/finding-ids.cjs').assignFindingIds(findings, root);
}

function selectFindings(result, values) {
  if (values.settings) result.findings = values.settings.apply(result.findings, process.cwd());
  result.findings = result.findings.filter((finding) => !values.ignore.includes(finding.ruleId));
  if (values['include-contextual'] !== undefined) {
    const classifyTestWrite = require('../performance/review-context.cjs').createTestWriteClassifier();
    let contextualCount = 0;
    result.findings = result.findings.filter((finding) => {
      const reason = finding.contextualReason || classifyTestWrite(finding.file, finding.ruleId);
      if (!reason) return true;
      finding.contextualReason = reason;
      contextualCount++;
      return values['include-contextual'];
    });
    if (contextualCount) result.contextualFindingCount = contextualCount;
  }
  for (const finding of result.findings) finding.impactLevel ??= impactByRule[finding.ruleId];
  result.findings = sortByImpactWithinFiles(filterMinImpact(result.findings, values['min-impact']));
  return result.findings;
}

// `print` receives each output line; the shared perf and sec run collects them per pillar.
function printResult(result, values, pillar, print = console.log) {
  // Ids are assigned before filtering, so collision suffixes do not depend on which findings are shown.
  const idRoot = findingRoot(values.project);
  assignFindingIds(result.findings, idRoot);
  selectFindings(result, values);
  if (values.changedLines) {
    const { keepChangedFindings } = require('../performance/changed-lines.cjs');
    const sourceFindings = result.findings.filter(({ ruleId }) => ruleId !== 'dependency-known-vulnerability');
    const dependencies = result.findings.filter(({ ruleId }) => ruleId === 'dependency-known-vulnerability');
    result.findings = [...keepChangedFindings(sourceFindings, values.changedLines), ...dependencies];
  }
  const format = resolveFormat(values);
  const baseline = applyBaselineOptions({
    options: values.baselineOptions ?? {},
    pillar: 'security',
    findings: result.findings,
    projectRoot: values.projectDirectory,
    absoluteFileOf: (finding) => path.resolve(finding.file),
    idRoot,
  });
  if (baseline?.written !== undefined) {
    const message = `Wrote ${baseline.written} finding(s) to ${path.relative(process.cwd(), baseline.file) || baseline.file}.`;
    (format === 'text' ? print : console.error)(message);
    return 0;
  }
  if (baseline) {
    result.findings = baseline.findings;
    result.baselineHidden = baseline.hidden;
    result.baselineStale = baseline.stale;
  }
  const isContract = ({ ruleId }) => pillar.contractRules.has(ruleId);
  const contractOnly = values['fail-on'] === 'contract';
  if (contractOnly) {
    result.contractFindingCount = result.findings.filter(isContract).length;
  }
  const { attachExample } = require('../performance/finding-text.cjs');
  require('../performance/site-fix.cjs').attachSiteFixes(result.findings);
  for (const finding of result.findings) {
    finding.fixable = Boolean(finding.fix);
    attachExample(finding);
  }
  printSourceReport(result, values, baseline, format, print);
  const exitCount =
    values.settings?.exitCount(result.findings, contractOnly ? isContract : undefined) ??
    (contractOnly ? result.contractFindingCount : result.findings.length);
  return exitCount ? 1 : 0;
}

function printSourceReport(result, values, baseline, format, print) {
  if (format === 'json') print(JSON.stringify(result, null, values.watch ? 0 : 2));
  else if (format !== 'text') {
    const output = renderReports(format, [
      { pillar: 'security', root: process.cwd(), repositoryDirectory: values.projectDirectory, report: result },
    ]);
    if (output) print(output);
  } else if (values.changedLines) printChangedFindings(result.findings, values.fixCommand, print);
  else printTextSummary(result, values, print);
  if (format === 'text') {
    if (baseline) for (const line of baselineNoteLines(baseline)) print(line);
    const warningNote = values.settings?.warningNote(result.findings);
    if (warningNote && !values.changedLines) print(warningNote);
  }
}

function printTextSummary(result, values, print) {
  require('../performance/finding-text.cjs').printFindings(result.findings, values.fixCommand, print);
  const summary = `${result.scannedFiles} file(s) checked, ${result.findings.length} finding(s)`;
  print(
    values['fail-on'] === 'contract'
      ? `${summary}, ${result.contractFindingCount} enforced by --fail-on contract.`
      : summary + '.',
  );
  if (result.contextualFindingCount && !values['include-contextual']) {
    print(`${result.contextualFindingCount} contextual finding(s) available with --include-contextual.`);
  }
  const fixableIds = result.findings
    .filter((finding) => finding.fixable && !finding.fix?.requiresReview)
    .map((finding) => finding.id);
  if (values.fixCommand && fixableIds.length) {
    print(`Fix all: ${values.fixCommand} --fix --only ${fixableIds.join(',')}`);
  }
}

// Env files, Dockerfiles and compose files comment with #; source files with //.
const hashCommentFile = /(?:^|\/)(?:\.env[^/]*|[^/]*Dockerfile[^/]*|[^/]*\.ya?ml)$/i;

function dismissCommentPrefix(file) {
  return hashCommentFile.test(file) ? '#' : '//';
}

// Terse form for commits: where it is, what it says, then the exact command to fix or dismiss it.
function printChangedFindings(findings, fixCommand, print) {
  const { findingLabel } = require('../performance/finding-text.cjs');
  for (const finding of findings) {
    print(`${finding.file}:${finding.line} ${findingLabel(finding)} ${finding.impactLevel}: ${finding.message}`);
    if (finding.fixable) print(`  fix:     ${fixCommand} --fix --only ${finding.id}`);
    print(`  dismiss: ${dismissCommentPrefix(finding.file)} loadwise-reviewed ${finding.ruleId} -- <reason>`);
  }
  const fixableIds = findings
    .filter((finding) => finding.fixable && !finding.fix?.requiresReview)
    .map((finding) => finding.id);
  if (fixableIds.length > 1) print(`Fix all: ${fixCommand} --fix --only ${fixableIds.join(',')}`);
  print(
    findings.length
      ? `${findings.length} new finding(s) in changed lines. Apply fixes, then \`git add\` the files and commit again.`
      : 'No new findings in changed lines.',
  );
}

// The same inputs make `--fix --only` rescan what was reported, so the ids it is given still match.
function fixAllCommand(command, project, files, values) {
  const inputs = [];
  if (project !== undefined) inputs.push('-p', project);
  for (const name of values.workspace) inputs.push('--workspace', name);
  for (const flag of ['policy', 'loadwise-config']) {
    if (values[flag]) inputs.push('--' + flag, values[flag]);
  }
  if (command === 'perf') {
    if (values.schema) inputs.push('--schema', values.schema);
    const engine = values.with === 'sec' ? 'js' : values.native ? 'native' : values.engine;
    if (engine) inputs.push('--engine', engine);
  }
  inputs.push(...files.map((file) => (file.startsWith('-') ? './' + file : file)));
  return [`npx loadwise ${command}`, ...inputs.map(quoteArgument)].join(' ');
}

module.exports = { findingRoot, assignFindingIds, selectFindings, printResult, fixAllCommand };
