import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const slowSource = fs.readFileSync(path.resolve(__dirname, '../../examples/slow.ts'), 'utf8');
const quietSource = 'export const answer = 42;\n';
const reviewCommand = 'loadwise agent instructions';
const explicitAgent = { LOADWISE_AGENT: '1' };
const codexShell = { CODEX_THREAD_ID: '018ff57e-e7ed-70d7-9c66-3026a2b95280', CODEX_TOOL_CALL_ID: 'call_test' };

interface ReviewedFinding {
  id: string;
  checker: string;
  ruleId: string;
  fix: { changes: unknown[] };
}

interface AgentHistory {
  enabled: boolean;
  runs: { applied: ReviewedFinding[] }[];
}

function workspace(context: TestContext, source = quietSource) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(base, 'loadwise-first-run-'));
  context.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const project = path.join(scratch, 'consumer');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  fs.writeFileSync(path.join(project, 'tsconfig.json'), '{"files":["entry.ts"]}');
  fs.writeFileSync(path.join(project, 'entry.ts'), source);
  // Launch each CLI as a fresh process with only the environment supplied by this fixture's caller.
  const baseEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(?:path|systemroot|windir|pathext|comspec|home|userprofile|tmp|temp|tmpdir|lang|lc_all)$/i.test(name),
    ),
  );
  const state = path.join(scratch, 'local-state');
  const run = (args: string[], signals: Record<string, string> = {}, cwd = project, expectedStatus = 0) => {
    const env = { ...baseEnvironment, LOCALAPPDATA: state, XDG_STATE_HOME: state, ...signals };
    const result = spawnSync(process.execPath, [bin, ...args], { cwd, env, encoding: 'utf8', windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
    return result;
  };
  return { project, run, scratch };
}

test('a manual IDE or CI terminal receives no agent workflow, and explicit off wins over agent signals', (context) => {
  const { project, run } = workspace(context);
  const files = fs.readdirSync(project);
  const terminal = {
    TERM_PROGRAM: 'vscode',
    VSCODE_PID: '200',
    MSYSTEM: 'MINGW64',
    CI: 'true',
    GITHUB_ACTIONS: 'true',
  };
  for (const signals of [terminal, { ...codexShell, LOADWISE_AGENT: '0' }]) {
    const checked = run(['check'], signals);
    assert.match(checked.stdout, /== Performance ==/);
    assert.doesNotMatch(checked.stderr + checked.stdout, /coding agents?:|loadwise agent instructions/i);
    const fixed = run(['fix', '--yes', 'performance'], signals);
    assert.doesNotMatch(fixed.stderr + fixed.stdout, /coding agent|loadwise agent instructions/i);
    assert.equal(JSON.parse(run(['agent', 'history']).stdout).enabled, false);
  }
  assert.deepEqual(fs.readdirSync(project), files);
});

test('an agent gets one review prompt on a clean sibling project scan while JSON and SARIF stay parseable', (context) => {
  const { project, run, scratch } = workspace(context);
  const caller = path.join(scratch, 'caller');
  fs.mkdirSync(caller);
  fs.writeFileSync(path.join(caller, 'package.json'), '{}');
  const files = fs.readdirSync(project);
  const checked = run(['check', '../consumer', '--only', 'perf,sec', '--json'], codexShell, caller);
  const report = JSON.parse(checked.stdout);
  assert.deepEqual(Object.keys(report), ['performance', 'security']);
  assert.deepEqual(report.performance.findings, []);
  assert.deepEqual(report.security.findings, []);
  assert.equal(checked.stderr.split(reviewCommand).length - 1, 1, checked.stderr);
  const sarif = run(['check', '--only', 'perf', '--format', 'sarif'], explicitAgent);
  assert.equal(JSON.parse(sarif.stdout).version, '2.1.0');
  assert.equal(sarif.stderr.split(reviewCommand).length - 1, 1, sarif.stderr);
  assert.equal(JSON.parse(run(['agent', 'history'], {}, caller).stdout).enabled, false);
  assert.deepEqual(fs.readdirSync(caller), ['package.json']);
  assert.deepEqual(fs.readdirSync(project), files);
});

test('the first command can be an agent fix, with actual edits recoverable and decisions saved without init', (context) => {
  const { project, run, scratch } = workspace(context, slowSource);
  const files = fs.readdirSync(project);
  const first = run(['fix', '--yes', 'performance', '--json'], explicitAgent);
  assert.equal(first.stderr.split(reviewCommand).length - 1, 1, first.stderr);
  const fixed: { applied: ReviewedFinding[]; instructions: string } = JSON.parse(first.stdout);
  assert.equal(fixed.applied.length, 3);
  assert.match(fixed.instructions, /including fixes already applied/);
  assert.notEqual(fs.readFileSync(path.join(project, 'entry.ts'), 'utf8'), slowSource);
  const history: AgentHistory = JSON.parse(run(['agent', 'history', 'performance'], explicitAgent).stdout);
  assert.equal(history.enabled, true);
  assert.equal(history.runs.length, 1);
  const receipt = history.runs[0].applied;
  assert.deepEqual(
    receipt.map(({ id }) => id),
    fixed.applied.map(({ id }) => id),
  );
  for (const finding of receipt) assert.ok(finding.fix.changes.length);
  const outcomes = receipt.map(({ id, checker, ruleId }) => ({
    id,
    checker,
    status: 'verified',
    evidence: `Compared the ${ruleId} edit to the captured source changes in entry.ts.`,
  }));
  const historyPath = path.join(scratch, 'history.json');
  const decisionsPath = path.join(scratch, 'outcomes.json');
  fs.writeFileSync(historyPath, JSON.stringify(history));
  fs.writeFileSync(decisionsPath, JSON.stringify({ outcomes }));
  const verification = run(['agent', 'verify', '--save', '--outcomes', decisionsPath, historyPath], explicitAgent);
  const coverage = JSON.parse(verification.stdout);
  assert.equal(coverage.complete, true);
  assert.equal(coverage.saved, 3);
  assert.equal(JSON.parse(run(['agent', 'history'], explicitAgent).stdout).reviews.length, 3);
  fs.writeFileSync(path.join(project, 'entry.ts'), slowSource);
  const manualFix = run(['fix', '--yes', 'performance', '--json']);
  assert.equal(JSON.parse(manualFix.stdout).applied.length, 3);
  assert.doesNotMatch(manualFix.stderr, /loadwise agent instructions/i);
  assert.equal(JSON.parse(run(['agent', 'history'], explicitAgent).stdout).runs.length, 1);
  assert.deepEqual(fs.readdirSync(project), files);
});

test('an agent can save its first review after a check that returns findings without applying any fixes', (context) => {
  const { project, run, scratch } = workspace(context, slowSource);
  const checked = run(['check', '--only', 'perf', '--json'], explicitAgent, project, 1);
  assert.equal(checked.stderr.split(reviewCommand).length - 1, 1, checked.stderr);
  const reportPath = path.join(scratch, 'findings.json');
  fs.writeFileSync(reportPath, checked.stdout);
  const findings: ReviewedFinding[] = JSON.parse(checked.stdout).performance.findings;
  assert.equal(findings.length, 3);
  const outcomes = findings.map(({ id, ruleId }) => ({
    checker: 'perf',
    id,
    status: 'deferred',
    evidence: `The ${ruleId} suggestion in visibleNames needs a workload measurement before changing the implementation.`,
  }));
  const decisionsPath = path.join(scratch, 'outcomes.json');
  fs.writeFileSync(decisionsPath, JSON.stringify({ outcomes }));
  const result = run(['agent', 'verify', '--save', '--outcomes', decisionsPath, reportPath], explicitAgent);
  assert.equal(JSON.parse(result.stdout).saved, 3);
  const history = JSON.parse(run(['agent', 'history'], explicitAgent).stdout);
  assert.deepEqual(history.runs, []);
  assert.equal(history.reviews.length, 3);
  assert.equal(fs.readFileSync(path.join(project, 'entry.ts'), 'utf8'), slowSource);
});

test('an agent can read review instructions without a scan or an edit to existing project instructions', (context) => {
  const { project, run } = workspace(context);
  const ownerInstructions = '# Project instructions\nUse the existing build command.\n';
  const agentsFile = path.join(project, 'AGENTS.md');
  fs.writeFileSync(agentsFile, ownerInstructions);
  const files = fs.readdirSync(project);
  for (const args of [['--version'], ['check', '--help'], ['explain', 'array-repeated-find']]) {
    assert.doesNotMatch(run(args, explicitAgent).stderr, /loadwise agent instructions/i);
  }
  const instructions = run(['agent', 'instructions'], explicitAgent);
  assert.match(instructions.stdout, /review every finding/i);
  assert.match(instructions.stdout, /loadwise agent verify/);
  assert.doesNotMatch(instructions.stderr, /loadwise agent instructions/i);
  assert.deepEqual(fs.readdirSync(project), files);
  assert.equal(fs.readFileSync(agentsFile, 'utf8'), ownerInstructions);
  assert.equal(JSON.parse(run(['agent', 'history']).stdout).enabled, false);
});
