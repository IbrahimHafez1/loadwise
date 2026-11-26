import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { loadConfig, loadSettings } from '../../lib/shared/config.js';

function writeConfig(context: TestContext, config: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-config-options-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'loadwise.config.json'), JSON.stringify(config));
  return directory;
}

test('accepts valid per-rule options in rules and overrides and merges them in ruleOptions', (context) => {
  const directory = writeConfig(context, {
    rules: {
      'deep-control-flow': { level: 'warn', options: { maxDepth: 3 } },
      'high-branch-complexity': { level: 'error', options: { maxComplexity: 12 } },
      'long-parameter-list': { level: 'warn', options: { maxParams: 4 } },
      'large-module': { level: 'warn', options: { maxLines: 500 } },
      'bcrypt-low-cost': { level: 'error', options: { minCost: 12 } },
      'graphql-query-depth-unbounded': { level: 'error', options: { maxDepth: 8 } },
    },
    overrides: [
      {
        files: ['src/legacy/**'],
        rules: {
          'deep-control-flow': { level: 'warn', options: { maxDepth: 6 } },
        },
      },
    ],
  });

  const loaded = loadConfig({ directory });
  assert.ok(loaded);
  const settings = loadSettings({ directory });
  assert.deepEqual(settings.ruleOptions('deep-control-flow', 'src/app.ts'), { maxDepth: 3 });
  assert.deepEqual(settings.ruleOptions('deep-control-flow', 'src/legacy/old.ts'), { maxDepth: 6 });
  assert.deepEqual(settings.ruleOptions('bcrypt-low-cost'), { minCost: 12 });
  assert.equal(settings.ruleOptions('floating-promise'), undefined);
});

test('rejects unknown option names on configurable and non-configurable rules', (context) => {
  const unknownForConfigurable = writeConfig(context, {
    rules: {
      'deep-control-flow': { level: 'warn', options: { maxComplexity: 5 } },
    },
  });
  assert.throws(
    () => loadConfig({ directory: unknownForConfigurable }),
    /unknown option "maxComplexity" for rule "deep-control-flow" in rules/,
  );

  const unknownForPlainRule = writeConfig(context, {
    rules: {
      'floating-promise': { level: 'warn', options: { maxDepth: 2 } },
    },
  });
  assert.throws(
    () => loadConfig({ directory: unknownForPlainRule }),
    /unknown option "maxDepth" for rule "floating-promise" in rules/,
  );

  const emptyForPlainRule = writeConfig(context, {
    overrides: [
      {
        files: ['src/**'],
        rules: {
          'floating-promise': { level: 'warn', options: {} },
        },
      },
    ],
  });
  assert.throws(
    () => loadConfig({ directory: emptyForPlainRule }),
    /rule "floating-promise" in overrides\[0\]\.rules does not accept options/,
  );
});

test('rejects invalid option value types, non-object options, and out-of-range values', (context) => {
  const wrongType = writeConfig(context, {
    rules: {
      'long-parameter-list': { level: 'warn', options: { maxParams: '5' } },
      'large-module': { level: 'warn', options: { maxLines: 10.5 } },
    },
  });
  assert.throws(
    () => loadConfig({ directory: wrongType }),
    /option "maxParams" for rule "long-parameter-list" in rules must be a integer[\s\S]*option "maxLines" for rule "large-module" in rules must be a integer/,
  );

  const belowMin = writeConfig(context, {
    rules: {
      'bcrypt-low-cost': { level: 'error', options: { minCost: 0 } },
    },
  });
  assert.throws(
    () => loadConfig({ directory: belowMin }),
    /option "minCost" for rule "bcrypt-low-cost" in rules must be >= 1/,
  );

  const nonObjectOptions = writeConfig(context, {
    rules: {
      'deep-control-flow': { level: 'warn', options: [3] },
    },
  });
  assert.throws(
    () => loadConfig({ directory: nonObjectOptions }),
    /rules\.deep-control-flow\.options must be an object/,
  );
});
