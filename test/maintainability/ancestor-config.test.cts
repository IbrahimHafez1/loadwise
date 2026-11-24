import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scan } from '../../lib/maintainability/scan.cjs';
import { defaultLimits } from '../../lib/maintainability/limits.cjs';
import type { MaintainabilityPolicy } from '../../lib/maintainability/types/policy.cjs';
import type { FileMap } from '../types/project-files.cjs';
import type { Finding } from '../../lib/shared/types.cjs';

const policy: MaintainabilityPolicy = { exclude: [], boundaries: [], placement: [], limits: defaultLimits };

// Writes `files` below a fresh folder and scans `scanned` inside it.
async function scanFindings(files: FileMap, scanned = '.') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-ancestor-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), text);
    }
    const report = await scan(path.join(root, scanned), policy);
    return report.findings.filter((finding) => /^unused-export$|^unreferenced-file$/.test(finding.ruleId));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const summary = (findings: Finding[]) => findings.map((finding: Finding) => `${finding.ruleId} ${finding.file}`).sort();

test('files a package.json above the scanned folder exports are entry points', async () => {
  const findings = await scanFindings(
    {
      'packages/core/package.json': JSON.stringify({
        name: '@acme/core',
        exports: { './api/*': './dist/api/*.js', './feature': './dist/features/feature.js' },
      }),
      'packages/core/src/api/users.ts': 'export const users = 1;',
      'packages/core/src/features/feature.ts': 'export const feature = 1;',
      'packages/core/src/features/stray.ts': 'export const stray = 1;',
    },
    'packages/core/src',
  );
  assert.deepEqual(summary(findings), ['unreferenced-file features/stray.ts']);
});

test('imports resolve through path aliases of a tsconfig above the scanned folder', async () => {
  const files = {
    '.git/HEAD': 'ref: refs/heads/main',
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@server/*': ['server/*'] } } }),
    'server/main.ts': 'import { value } from "@server/lib/value"; console.log(value);',
    'server/lib/value.ts': 'export const value = 1;',
  };
  assert.deepEqual(summary(await scanFindings(files, 'server')), []);
  const withOwnConfig = { ...files, 'server/tsconfig.json': '{"compilerOptions":{"strict":true}}' };
  assert.deepEqual(summary(await scanFindings(withOwnConfig, 'server')), []);
});

test('an export that sibling workspace members do not import is reported in a file they import by name', async () => {
  const findings = await scanFindings(
    {
      'package.json': '{"private":true,"workspaces":["apps/*","packages/*"]}',
      'apps/web/package.json': '{"name":"web"}',
      'apps/web/page.tsx': 'import { AppList } from "@acme/features/apps/AppList";\nexport default AppList;',
      'apps/web/other.tsx': 'import Whole from "@acme/features/apps/Whole";\nexport default Whole;',
      'packages/features/package.json': '{"name":"@acme/features"}',
      'packages/features/apps/AppList.tsx': 'export const AppList = 1;\nexport const Spare = 2;',
      'packages/features/apps/Whole.tsx': 'export const Spare = 2;\nexport default 1;',
    },
    'packages/features',
  );
  assert.deepEqual(summary(findings), ['unused-export apps/AppList.tsx', 'unused-export apps/Whole.tsx']);
  assert.deepEqual(findings.map((finding) => finding.exportName).sort(), ['Spare', 'Spare']);
});
