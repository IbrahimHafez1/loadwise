import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Finding } from '../../lib/shared/types.js';
import { reasonOf } from '../types/finding-reason.js';
import { parseReport } from '../types/cli-report.js';
import * as nativeRuntime from '../../lib/performance/native-runtime.js';

test('overlapping projects retain the visible advisory in either reference order', async (context) => {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backend-perf-review-context-'));
  const callback = 'declare function it(name: string, work: () => Promise<void>): void;';
  const jestDeclaration = 'node_modules/@types/jest/index.d.ts';
  const leaf = (declaration: string) =>
    JSON.stringify({
      compilerOptions: { target: 'ES2022', types: [] },
      files: ['service.ts', declaration],
    });
  const solution = (...configs: string[]) =>
    JSON.stringify({ files: [], references: configs.map((file) => ({ path: './' + file })) });
  const files = {
    'service.ts': "import {readFileSync} from 'node:fs'; it('work', async () => { readFileSync('report'); });",
    [jestDeclaration]: callback,
    'service-callback.d.ts': callback,
    'jest.json': leaf(jestDeclaration),
    'service.json': leaf('service-callback.d.ts'),
    'jest-first.json': solution('jest.json', 'service.json'),
    'service-first.json': solution('service.json', 'jest.json'),
  };
  const directories = ['node_modules', 'node_modules/@types', 'node_modules/@types/jest'];
  context.after(() => {
    for (const file of Object.keys(files)) fs.rmSync(path.join(root, file), { force: true });
    for (const folder of [...directories].reverse()) fs.rmdirSync(path.join(root, folder));
    fs.rmdirSync(root);
  });
  for (const folder of directories) fs.mkdirSync(path.join(root, folder));
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(root, name), source);

  const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
  for (const native of [false, true]) {
    await context.test(native ? 'native compiler' : 'TypeScript compiler', (subtest) => {
      if (native) {
        const [major, minor] = process.versions.node.split('.').map(Number);
        if (major < 22 || (major === 22 && minor < 13)) return subtest.skip('Native requires Node 22.13+');
        try {
          nativeRuntime.executable();
        } catch {
          return subtest.skip('Optional native compiler is absent');
        }
      }
      function scan(config: string, ...options: string[]) {
        const args = [bin, 'perf', ...(native ? ['--native'] : []), '-p', config, '--json', ...options];
        const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 1, result.stderr || result.stdout);
        return parseReport(result.stdout);
      }
      const fixture = scan('jest.json', '--include-contextual');
      assert.equal(fixture.contextualFindingCount, 1);
      assert.match(reasonOf(fixture.findings[0]), /unit-test/);
      const service = scan('jest-first.json');
      assert.deepEqual(service, scan('service-first.json'));
      assert.equal(service.scannedFiles, 1);
      assert.deepEqual(
        service.findings.map((finding: Finding) => [finding.ruleId, finding.contextualReason]),
        [['node-sync-fs-in-async', undefined]],
      );
    });
  }
});
