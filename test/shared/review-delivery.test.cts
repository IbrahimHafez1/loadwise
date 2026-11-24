import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

interface CliRun {
  status: number | string;
  stdout: string;
  stderr: string;
}

interface HandoffEvent {
  report: unknown;
}

interface PendingReviews {
  files: string[];
}

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const slowSource = fs.readFileSync(path.resolve(__dirname, '../../examples/slow.ts'), 'utf8');

function terminalFixture(context: TestContext) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'loadwise-delivery-'));
  const state = path.join(root, 'state');
  fs.mkdirSync(state, { mode: 0o700 });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(?:path|systemroot|windir|pathext|comspec|home|userprofile|tmp|temp|tmpdir|lang|lc_all)$/i.test(name),
    ),
  );
  Object.assign(env, { LOCALAPPDATA: state, XDG_STATE_HOME: state, XDG_RUNTIME_DIR: state });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  function project(name: string, source: string) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'package.json'), '{}');
    fs.writeFileSync(path.join(directory, 'tsconfig.json'), '{"files":["entry.ts"]}');
    fs.writeFileSync(path.join(directory, 'entry.ts'), source);
    return directory;
  }

  async function run(
    cwd: string,
    args: readonly string[],
    status: number,
    signals: Record<string, string> = {},
  ): Promise<CliRun> {
    const result = await new Promise<CliRun>((resolve) => {
      execFile(
        process.execPath,
        [bin, ...args],
        {
          cwd,
          env: { ...env, ...signals },
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30000,
        },
        (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
      );
    });
    assert.equal(result.status, status, result.stderr || result.stdout);
    return result;
  }

  return { project, run };
}

test('a check returns findings directly to its caller and keeps explicit report saving optional', async (context) => {
  const { project, run } = terminalFixture(context);
  const directory = project('consumer', slowSource);
  const args = ['check', '--only', 'perf', '--json'];
  const manual = await run(directory, args, 1);
  const agent = await run(directory, args, 1, { LOADWISE_AGENT: '1' });
  assert.deepEqual(JSON.parse(agent.stdout), JSON.parse(manual.stdout));
  assert.ok(JSON.parse(agent.stdout).performance.findings.length);
  assert.deepEqual(JSON.parse((await run(directory, ['agent', 'pending'], 0)).stdout).files, []);
  assert.equal(fs.readFileSync(path.join(directory, 'entry.ts'), 'utf8'), slowSource);
});

const handoffHeading = 'If you need to hand this run to an agent, paste this message:';

function parseHandoff(stderr: string): { file: string; event: HandoffEvent } {
  const lines = stderr.split(/\r?\n/);
  const heading = lines.indexOf(handoffHeading);
  assert.notEqual(heading, -1, stderr);
  const prompt = lines[heading + 1];
  assert.ok(prompt);
  assert.match(prompt, /^Review this Loadwise run without editing files\./);
  assert.match(prompt, /Never repeat a fix/i);
  const quoted = prompt.match(/"(?:[^"\\]|\\.)*report\.json"/)?.[0];
  assert.ok(quoted, prompt);
  const file: string = JSON.parse(quoted);
  assert.ok(path.isAbsolute(file));
  const id = path.basename(path.dirname(file));
  assert.match(prompt, /loadwise_read_report/);
  assert.ok(prompt.replace(quoted, '').includes(id), prompt);
  return { file, event: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('the review fallback hands off the exact scoped scan and fix receipts without a live agent', async (context) => {
  const { project, run } = terminalFixture(context);
  const directory = project('consumer', slowSource);
  const scan = await run(directory, ['--review', '--only', 'perf', '--json'], 1);
  assert.deepEqual(parseHandoff(scan.stderr).event.report, JSON.parse(scan.stdout));
  const fix = await run(directory, ['fix', 'performance', '--yes', '--json', '--review'], 0);
  assert.equal(JSON.parse(fix.stdout).applied.length, 3);
  assert.deepEqual(parseHandoff(fix.stderr).event.report, JSON.parse(fix.stdout));
  const check = await run(directory, ['check', '--only', 'perf', '--json'], 0);
  assert.ok(!check.stderr.includes(handoffHeading));
  assert.doesNotMatch(check.stderr, /Saved for this project/);
  const pending: PendingReviews = JSON.parse((await run(directory, ['agent', 'pending'], 0)).stdout);
  assert.equal(pending.files.length, 2);
  assert.deepEqual(
    pending.files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')).report),
    [JSON.parse(scan.stdout), JSON.parse(fix.stdout)],
  );
});

test('a storage failure keeps the applied-fix report and explains how to share the original edits', async (context) => {
  const { project, run } = terminalFixture(context);
  const directory = project('no-storage', slowSource);
  const env = {
    LOCALAPPDATA: directory,
    XDG_STATE_HOME: directory,
    TMPDIR: directory,
    TEMP: directory,
    TMP: directory,
  };
  const fix = await run(directory, ['fix', '--yes', '--json', '--review'], 0, env);
  assert.equal(JSON.parse(fix.stdout).applied.length, 3);
  assert.match(fix.stderr, /could not save a private handoff/i);
  assert.match(fix.stderr, /fix has already run/);
  assert.ok(!fix.stderr.includes(handoffHeading));
});

test('a temporary handoff offers the exact file when the MCP inbox cannot store it', async (context) => {
  const { project, run } = terminalFixture(context);
  const directory = project('fallback', slowSource);
  const state = path.join(path.dirname(directory), 'state');
  fs.writeFileSync(path.join(state, 'loadwise'), 'occupied');
  const scan = await run(directory, ['check', '--only', 'perf', '--json', '--review'], 1, { TMPDIR: state });
  assert.ok(scan.stderr.includes(handoffHeading));
  const prompt = scan.stderr.split(/\r?\n/).find((line) => line.startsWith('Review this Loadwise run'));
  assert.ok(prompt);
  assert.match(prompt, /Never repeat a fix/);
  assert.doesNotMatch(prompt, /loadwise_read_report/);
  const quoted = prompt.match(/"(?:[^"\\]|\\.)*report\.json"/)?.[0];
  assert.ok(quoted);
  const file: string = JSON.parse(quoted);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).report, JSON.parse(scan.stdout));
});
