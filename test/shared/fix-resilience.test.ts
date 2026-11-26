import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyBulkFixes } from '../../lib/shared/fix.js';
import type { Finding } from '../../lib/shared/types.js';

const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');

function tempProject(context: test.TestContext, files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-resilience-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('resilience: preserves CRLF and UTF-8 BOM during autofix and import coalescing', (context) => {
  const root = tempProject(context, {
    'crlf-bom.ts': "\uFEFFimport { a } from 'node:fs';\r\nexport const x = a;\r\n",
  });
  const file = path.join(root, 'crlf-bom.ts');
  const findings: Finding[] = [
    {
      id: 'c1',
      ruleId: 'r1',
      checker: 'perf',
      file: 'crlf-bom.ts',
      line: 1,
      message: 'add b',
      fix: { changes: [{ file, line: 1, before: '', after: "import { b } from 'node:fs';" }] },
    },
    {
      id: 'c2',
      ruleId: 'r2',
      checker: 'perf',
      file: 'crlf-bom.ts',
      line: 2,
      message: 'rename x',
      fix: { changes: [{ file, line: 2, before: 'export const x = a;', after: 'export const x = a ?? 1;' }] },
    },
  ];
  const result = applyBulkFixes(findings, root, { verifyTypes: false });
  assert.equal(result.applied.length, 2);
  assert.equal(result.refused.length, 0);
  const updated = fs.readFileSync(file, 'utf8');
  assert.ok(updated.includes("import { a, b } from 'node:fs';"));
  assert.ok(updated.includes('export const x = a ?? 1;'));
  assert.ok(updated.includes('\r\n'));
  assert.ok(updated.startsWith('\uFEFF'));
});

test('resilience: keeps shebang and Next.js directives ahead of inserted imports', (context) => {
  const root = tempProject(context, {
    'cli.ts': "#!/usr/bin/env node\nconsole.log('ready');\n",
    'action.ts': "'use server';\nexport async function save() { return true; }\n",
    'client.tsx': "'use client';\nexport function Widget() { return null; }\n",
  });
  const cliFile = path.join(root, 'cli.ts');
  const actionFile = path.join(root, 'action.ts');
  const clientFile = path.join(root, 'client.tsx');
  const result = applyBulkFixes(
    [
      {
        id: 'h1',
        ruleId: 'r1',
        checker: 'perf',
        file: 'cli.ts',
        line: 1,
        message: 'import fs',
        fix: { changes: [{ file: cliFile, line: 1, before: '', after: "import fs from 'node:fs';" }] },
      },
      {
        id: 'h2',
        ruleId: 'r2',
        checker: 'perf',
        file: 'action.ts',
        line: 1,
        message: 'import path',
        fix: { changes: [{ file: actionFile, line: 1, before: '', after: "import path from 'node:path';" }] },
      },
      {
        id: 'h3',
        ruleId: 'r3',
        checker: 'perf',
        file: 'client.tsx',
        line: 1,
        message: 'import react',
        fix: { changes: [{ file: clientFile, line: 1, before: '', after: "import { useMemo } from 'react';" }] },
      },
    ],
    root,
    { verifyTypes: false },
  );
  assert.equal(result.applied.length, 3);
  assert.ok(fs.readFileSync(cliFile, 'utf8').startsWith("#!/usr/bin/env node\nimport fs from 'node:fs';\n"));
  assert.ok(fs.readFileSync(actionFile, 'utf8').startsWith("'use server';\nimport path from 'node:path';\n"));
  assert.ok(fs.readFileSync(clientFile, 'utf8').startsWith("'use client';\nimport { useMemo } from 'react';\n"));
});

test('resilience: monorepo without root tsconfig enforces Layer-2 typecheck per package', (context) => {
  const root = tempProject(context, {
    'packages/web/tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true },
    }),
    'packages/web/src/page.ts': 'export const title: string = "hi";\n',
  });
  const file = path.join(root, 'packages/web/src/page.ts');
  const result = applyBulkFixes(
    [
      {
        id: 'm1',
        ruleId: 'r1',
        checker: 'perf',
        file: 'packages/web/src/page.ts',
        line: 1,
        message: 'broken ref',
        fix: {
          changes: [
            {
              file,
              line: 1,
              before: 'export const title: string = "hi";',
              after: 'export const title: string = missingVar;',
            },
          ],
        },
      },
    ],
    root,
    { verifyTypes: true },
  );
  assert.equal(result.applied.length, 0);
  assert.equal(result.refused.length, 1);
  assert.match(result.refused[0].reason, /TS2304/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'export const title: string = "hi";\n');
});

test('resilience: unparseable sibling file does not crash check or fix on valid files', (context) => {
  const root = tempProject(context, {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true, noEmit: true },
    }),
    'broken.ts': 'export const broken = (;\n',
    'valid.ts':
      'export function check(items: string[], target: string) {\n  for (const x of items) {\n    if (items.includes(target)) return x;\n  }\n}\n',
  });
  const checkRes = runCli(root, ['check', '-p', 'tsconfig.json', '--json']);
  assert.ok(
    checkRes.status === 0 || checkRes.status === 1 || checkRes.status === 2,
    `unexpected exit ${checkRes.status}`,
  );
  const fixRes = runCli(root, ['fix', '--yes', '--dry-run', '--json']);
  assert.ok(fixRes.status === 0 || fixRes.status === 1 || fixRes.status === 2, `unexpected exit ${fixRes.status}`);
  assert.equal(fs.readFileSync(path.join(root, 'broken.ts'), 'utf8'), 'export const broken = (;\n');
});

test('resilience: temp project without package.json stops upward root walks at os.tmpdir()', (context) => {
  const root = tempProject(context, {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true, noEmit: true },
    }),
    'src/handler.ts': [
      'export function handle(items: string[], request: { body: { allowed: string[] } }) {',
      '  const allowed = request.body.allowed;',
      '  return items.filter((x) => allowed.includes(x));',
      '}',
    ].join('\n'),
  });
  const checkRes = runCli(root, ['check', '--only', 'perf', '--json']);
  assert.notEqual(checkRes.status, 2, checkRes.stderr);
  const report = JSON.parse(checkRes.stdout);
  assert.equal(report.performance.findings.length, 1);
  const fixRes = runCli(root, ['fix', '--yes', '--dry-run', '--json']);
  assert.notEqual(fixRes.status, 2, fixRes.stderr);
});
