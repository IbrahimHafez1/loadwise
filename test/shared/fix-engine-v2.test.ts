import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyBulkFixes } from '../../lib/shared/fix.js';
import { applyImportEdits } from '../../lib/shared/fix-imports.js';
import type { Finding } from '../../lib/shared/types.js';

function tempProject(context: test.TestContext, files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-fix-v2-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('fix-imports: coalesces same-module imports in 1 pass without line-1 collisions', (context) => {
  const root = tempProject(context, {
    'app.ts': "import { a } from 'node:fs';\nexport const x = a;\n",
  });
  const file = path.join(root, 'app.ts');
  const findings: Finding[] = [
    {
      id: 'f1',
      ruleId: 'r1',
      checker: 'perf',
      file: 'app.ts',
      line: 1,
      message: 'add b',
      fix: {
        changes: [
          {
            file,
            line: 1,
            before: "import { a } from 'node:fs';",
            after: "import { a, b } from 'node:fs';",
          },
        ],
      },
    },
    {
      id: 'f2',
      ruleId: 'r2',
      checker: 'perf',
      file: 'app.ts',
      line: 1,
      message: 'add c',
      fix: {
        changes: [
          {
            file,
            line: 1,
            before: "import { a } from 'node:fs';",
            after: "import { a, c } from 'node:fs';",
          },
        ],
      },
    },
  ];
  const result = applyBulkFixes(findings, root, { verifyTypes: false });
  assert.equal(result.applied.length, 2);
  assert.equal(result.refused.length, 0);
  const updated = fs.readFileSync(file, 'utf8');
  assert.match(updated, /import \{ a, b, c \} from 'node:fs';/);

  const direct = applyImportEdits("import { x } from 'mod';\n", [
    { moduleSpecifier: 'mod', named: ['y', 'x'] },
    { moduleSpecifier: 'other', defaultName: 'other' },
  ]);
  assert.match(direct, /import \{ x, y \} from 'mod';/);
  assert.match(direct, /import other from 'other';/);
});

test('fix convergence: multi-pass loop converges overlapping-range fixes in one transaction', (context) => {
  const root = tempProject(context, {
    'multi.ts': ['const a = 1;', 'const b = 2;', 'const c = 3;', ''].join('\n'),
  });
  const file = path.join(root, 'multi.ts');
  const findings: Finding[] = [
    {
      id: 'm1',
      ruleId: 'r1',
      checker: 'perf',
      file: 'multi.ts',
      line: 1,
      message: 'expand a',
      fix: {
        changes: [
          { file, line: 1, before: 'const a = 1;\nconst b = 2;', after: 'const a = 10;\nconst x = 99;\nconst b = 2;' },
        ],
      },
    },
    {
      id: 'm2',
      ruleId: 'r2',
      checker: 'perf',
      file: 'multi.ts',
      line: 2,
      message: 'update b',
      fix: { changes: [{ file, line: 2, before: 'const b = 2;', after: 'const b = 20;' }] },
    },
  ];
  const result = applyBulkFixes(findings, root, { verifyTypes: false });
  assert.equal(result.applied.length, 2);
  assert.equal(result.refused.length, 0);
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    ['const a = 10;', 'const x = 99;', 'const b = 20;', 'const c = 3;', ''].join('\n'),
  );
});

test('fix-typecheck: refuses a mock fixer introducing TS2304 while applying valid sibling fixes', (context) => {
  const root = tempProject(context, {
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true } }),
    'bad.ts': 'export const value: number = 1;\n',
    'good.ts': 'export const ok: number = 1;\n',
  });
  const badFile = path.join(root, 'bad.ts');
  const goodFile = path.join(root, 'good.ts');
  const findings: Finding[] = [
    {
      id: 'bad1',
      ruleId: 'r-bad',
      checker: 'perf',
      file: 'bad.ts',
      line: 1,
      message: 'bad',
      fix: {
        changes: [
          {
            file: badFile,
            line: 1,
            before: 'export const value: number = 1;',
            after: 'export const value: number = missingIdentifier;',
          },
        ],
      },
    },
    {
      id: 'good1',
      ruleId: 'r-good',
      checker: 'perf',
      file: 'good.ts',
      line: 1,
      message: 'good',
      fix: {
        changes: [
          { file: goodFile, line: 1, before: 'export const ok: number = 1;', after: 'export const ok: number = 2;' },
        ],
      },
    },
  ];
  const result = applyBulkFixes(findings, root, { verifyTypes: true });
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].id, 'good1');
  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0].finding.id, 'bad1');
  assert.match(result.refused[0].reason, /TS2304/);
  assert.equal(fs.readFileSync(badFile, 'utf8'), 'export const value: number = 1;\n');
  assert.equal(fs.readFileSync(goodFile, 'utf8'), 'export const ok: number = 2;\n');
});

test('fix-imports: preserves shebang and directive prologues and merges single-change matching imports', (context) => {
  const shebangResult = applyImportEdits("#!/usr/bin/env node\nconsole.log('hi');\n", [
    { moduleSpecifier: 'node:fs', named: ['readFileSync'] },
  ]);
  assert.equal(shebangResult, "#!/usr/bin/env node\nimport { readFileSync } from 'node:fs';\nconsole.log('hi');\n");

  const directiveResult = applyImportEdits("'use server';\nexport async function run() {}\n", [
    { moduleSpecifier: 'node:path', defaultName: 'path' },
  ]);
  assert.equal(directiveResult, "'use server';\nimport path from 'node:path';\nexport async function run() {}\n");

  const root = tempProject(context, {
    'single.ts': "import { a } from 'node:fs';\nexport const v = a;\n",
  });
  const file = path.join(root, 'single.ts');
  const result = applyBulkFixes(
    [
      {
        id: 's1',
        ruleId: 'r1',
        checker: 'perf',
        file: 'single.ts',
        line: 1,
        message: 'add b',
        fix: { changes: [{ file, line: 1, before: '', after: "import { b } from 'node:fs';" }] },
      },
    ],
    root,
    { verifyTypes: false },
  );
  assert.equal(result.applied.length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), "import { a, b } from 'node:fs';\nexport const v = a;\n");
});

test('fix-typecheck: resolves per-package tsconfig.json in monorepos without a root tsconfig', (context) => {
  const root = tempProject(context, {
    'packages/api/tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true },
    }),
    'packages/api/src/handler.ts': 'export const count: number = 1;\n',
  });
  const file = path.join(root, 'packages/api/src/handler.ts');
  const result = applyBulkFixes(
    [
      {
        id: 'mono1',
        ruleId: 'r-bad',
        checker: 'perf',
        file: 'packages/api/src/handler.ts',
        line: 1,
        message: 'bad',
        fix: {
          changes: [
            { file, line: 1, before: 'export const count: number = 1;', after: 'export const count: number = nope;' },
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
});
