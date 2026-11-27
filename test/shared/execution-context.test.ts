import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { classifyExecutionContext, isVendoredMinified } from '../../lib/shared/execution-context.js';
import { checkDockerfile } from '../../lib/security/files/dockerfile.js';
import { checkCompose } from '../../lib/security/files/compose.js';
import { isCatastrophicPattern } from '../../lib/security/injection/redos.js';
import { checkSwallowedErrors } from '../../lib/reliability/swallowed-errors.js';
import { configFilePaths } from '../../lib/maintainability/config-entry-points.js';

function sourceOf(fileName: string, code: string) {
  return ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
}

test('classifyExecutionContext identifies test-fixture, cli-tooling, browser, and node-server', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-exec-paths-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');

  assert.equal(
    classifyExecutionContext(sourceOf(path.join(root, 'e2e', 'login.ts'), 'export const x = 1;')).runtime,
    'test-fixture',
  );
  assert.equal(
    classifyExecutionContext(sourceOf(path.join(root, 'tools', 'release.ts'), 'export const x = 1;')).runtime,
    'cli-tooling',
  );
  assert.equal(
    classifyExecutionContext(sourceOf(path.join(root, 'bin.ts'), '#!/usr/bin/env node\nconsole.log(1);')).runtime,
    'cli-tooling',
  );
  assert.equal(
    classifyExecutionContext(sourceOf(path.join(root, 'src', 'App.tsx'), 'export const App = () => null;')).runtime,
    'browser',
  );
  assert.equal(
    classifyExecutionContext(sourceOf(path.join(root, 'src', 'helper.ts'), "import { useState } from 'react';"))
      .runtime,
    'browser',
  );
  assert.equal(
    classifyExecutionContext(sourceOf(path.join(root, 'src', 'server.ts'), "import express from 'express';")).runtime,
    'node-server',
  );
  assert.equal(
    classifyExecutionContext(sourceOf(path.join(root, 'src', 'plain.ts'), 'export const n = 1;')).runtime,
    'unknown',
  );
});

test('classifyExecutionContext detects package.json bin entries', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-exec-ctx-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ bin: { mycli: './dist/cli.js' } }));
  const cliFile = path.join(root, 'dist', 'cli.ts');
  assert.equal(classifyExecutionContext(sourceOf(cliFile, 'console.log(1);')).runtime, 'cli-tooling');
});

test('swallowed-errors skips typed fallback returns and telemetry-only JSON.stringify catches', () => {
  const code = `
    export function loadList() {
      try {
        return fetchList();
      } catch {}
      return [];
    }
    export function logTelemetry(data: unknown) {
      try {
        logger.info(JSON.stringify(data));
      } catch {}
    }
  `;
  const findings = checkSwallowedErrors(sourceOf('src/service.ts', code), 'src/service.ts');
  assert.deepEqual(findings, []);
});

test('config-entry-points extracts object entry maps and testDir', () => {
  const code = `
    export default {
      testDir: './e2e',
      entry: { main: 'src/main.ts', worker: 'src/worker.ts' },
    };
  `;
  const paths = configFilePaths(sourceOf('vite.config.ts', code));
  assert.deepEqual(paths, ['./e2e', 'src/main.ts', 'src/worker.ts']);
});

test('dockerfile and compose mark test/dev/local files as contextual', () => {
  const df = checkDockerfile('docker/fake-upgrades/Dockerfile', 'FROM node:20\nCMD ["node", "app.js"]\n');
  assert.equal(df[0]?.ruleId, 'dockerfile-runs-as-root');
  assert.ok(df[0]?.contextualReason);

  const compose = checkCompose(
    'services:\n  app:\n    environment:\n      API_SECRET: super_long_local_secret_123\n',
    'docker-compose.dev.yml',
  );
  assert.equal(compose[0]?.ruleId, 'compose-hardcoded-secret');
  assert.ok(compose[0]?.contextualReason);

  const scannerDf = checkDockerfile('.oss-scanner/Dockerfile', 'FROM node:22\nENV DB_PASSWORD=postgres\n');
  assert.ok(scannerDf.every((finding) => Boolean(finding.contextualReason)));
});

test('classifyExecutionContext distinguishes CLI-only packages from server packages with bin', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-exec-pkg-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');

  const cliPkg = path.join(root, 'packages', 'my-cli');
  fs.mkdirSync(path.join(cliPkg, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cliPkg, 'package.json'), JSON.stringify({ bin: './dist/index.js' }));
  assert.equal(
    classifyExecutionContext(sourceOf(path.join(cliPkg, 'src', 'helper.ts'), 'export const x = 1;')).runtime,
    'cli-tooling',
  );

  const serverCliPkg = path.join(root, 'packages', 'server-cli');
  fs.mkdirSync(path.join(serverCliPkg, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(serverCliPkg, 'package.json'),
    JSON.stringify({ bin: './dist/index.js', dependencies: { express: '^4.18.0' } }),
  );
  assert.equal(
    classifyExecutionContext(sourceOf(path.join(serverCliPkg, 'src', 'service.ts'), 'export const x = 1;')).runtime,
    'unknown',
  );

  const nextRoute = path.join(root, 'apps', 'api', 'app', 'stats', 'route.ts');
  fs.mkdirSync(path.dirname(nextRoute), { recursive: true });
  assert.equal(
    classifyExecutionContext(sourceOf(nextRoute, 'export async function GET() { return new Response(); }'), {
      getCompilerOptions: () => ({ lib: ['dom', 'esnext'] }),
    }).runtime,
    'node-server',
  );
});

test('isVendoredMinified and redos anchored trailing-dot heuristics', () => {
  assert.equal(isVendoredMinified('app/assets/vendor/chart/raphael-min.js'), true);
  assert.equal(isVendoredMinified('src/utils/chart.ts'), false);
  assert.equal(isCatastrophicPattern('^[Bb][Ee][Aa][Rr][Ee][Rr]\\s+(.+)$'), false);
  assert.equal(isCatastrophicPattern('^Bearer[ \\t]+(.+)$', 'i'), false);
  assert.equal(isCatastrophicPattern('^(a+)+$'), true);
});
