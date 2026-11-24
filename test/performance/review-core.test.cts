import test from 'node:test';
import assert from 'node:assert/strict';
import type { Finding } from '../../lib/shared/types.cjs';
import type * as PerformanceNativeRuntime from '../../lib/performance/native-runtime.cjs';
import type * as NativeFixture from './native-fixture.cjs';

const [major, minor] = process.versions.node.split('.').map(Number);
let skip = major < 22 || (major === 22 && minor < 13) ? 'native requires Node 22.13+' : false;
try {
  if (!skip) {
    const performanceNativeRuntimeModule: typeof PerformanceNativeRuntime = require('../../lib/performance/native-runtime.cjs');
    performanceNativeRuntimeModule.executable();
  }
} catch {
  skip = 'optional native compiler is absent';
}

const bcryptjs = {
  'node_modules/bcryptjs/package.json': '{"name":"bcryptjs","types":"index.d.ts"}',
  'node_modules/bcryptjs/index.d.ts':
    'export declare function hash(s: string, salt: number | string): Promise<string>;\n' +
    'export declare function compare(s: string, hash: string): Promise<boolean>;',
};

interface NativeClientModule {
  Client: { prototype: { apiRequest(method: string, params: unknown): unknown } };
}

function countRequests<Result>(run: () => Result): { result: Result; counts: Map<string, number> } {
  const { requireNative }: typeof PerformanceNativeRuntime = require('../../lib/performance/native-runtime.cjs');
  const { Client }: NativeClientModule = requireNative('./dist/api/sync/client.js');
  const original = Client.prototype.apiRequest;
  const counts = new Map<string, number>();
  Client.prototype.apiRequest = function (this: unknown, method: string, params: unknown) {
    counts.set(method, (counts.get(method) ?? 0) + 1);
    return original.call(this, method, params);
  };
  try {
    return { result: run(), counts };
  } finally {
    Client.prototype.apiRequest = original;
  }
}

test('native engine reads the literal bcryptjs cost instead of crashing', { skip }, () => {
  const { lint }: typeof NativeFixture = require('./native-fixture.cjs');
  const source = "import { hash } from 'bcryptjs';\nexport async function save(p: string) { return hash(p, 12); }\n";
  const findings = lint(source, bcryptjs);
  assert.deepEqual(
    findings.map((finding: Finding) => finding.ruleId),
    ['password-hash-pure-js'],
  );
  assert.match(findings[0].message, /at cost 12 burns/);
});

test('native engine resolves the call signatures of a file in one batched request', { skip }, () => {
  const { lint }: typeof NativeFixture = require('./native-fixture.cjs');
  const calls = Array.from({ length: 30 }, (_, index) => `  log(${index});`).join('\n');
  const source =
    "import { hash } from 'bcryptjs';\ndeclare function log(value: number): void;\n" +
    `export async function save(p: string) {\n${calls}\n  return hash(p, 12);\n}\n`;
  const { result, counts } = countRequests(() => lint(source, bcryptjs));
  assert.deepEqual(
    result.map((finding: Finding) => finding.ruleId),
    ['password-hash-pure-js'],
  );
  assert.equal(counts.get('getResolvedSignature') ?? 0, 0);
  assert.equal(counts.get('batchRequests'), 1);
});
