import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { attachRecipeFixes } from '../../lib/shared/fix-recipes.js';
import type { Finding } from '../../lib/shared/types.js';
import type { TestContext } from 'node:test';

const finding: Finding = {
  checker: 'maint',
  ruleId: 'deep-control-flow',
  message: 'nested',
  file: 'source.txt',
  line: 2,
  id: 'first',
};

function project(context: TestContext, recipe: string) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'loadwise-recipes-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'source.txt'), 'one\r\ntwo\r\nthree\r\n');
  fs.writeFileSync(path.join(directory, 'recipe.cjs'), 'module.exports = ' + recipe);
  return directory;
}

test('only matching manual findings receive review-marked same-file edits from an explicitly named module', async (context) => {
  const directory = project(
    context,
    `{
    'maint/deep-control-flow': async ({finding, source}) => {
      if (finding.id !== 'first') return null;
      if (!source.startsWith('one\\r\\n')) throw Error('unexpected content');
      finding.file = 'other.txt';
      return [{line: 2, before: 'two\\r\\nthree', after: 'second\\nthird'}];
    }
  }`,
  );
  const declined = { ...finding, id: 'second' };
  const unrelated = { ...finding, checker: 'sec' };
  const native = { ...finding, fix: { changes: [] } };
  const files = [finding, declined, unrelated, native];
  const [matched, ...remaining] = await attachRecipeFixes(files, './recipe.cjs', directory);
  assert.deepEqual(matched.fix, {
    requiresReview: true,
    changes: [{ file: 'source.txt', line: 2, before: 'two\nthree', after: 'second\nthird' }],
  });
  assert.equal(matched.fixable, true);
  assert.deepEqual(remaining, files.slice(1));
  assert.equal(finding.fix, undefined);
  assert.equal(finding.file, 'source.txt');
  assert.equal(fs.readFileSync(path.join(directory, 'source.txt'), 'utf8'), 'one\r\ntwo\r\nthree\r\n');
});

test('rejects malformed, stale, no-op and redirected replacements', async (context) => {
  const invalidOutputs = [
    [],
    [{ line: 1, before: 'one', after: 'first', file: 'other.txt' }],
    [{ line: 2, before: 'one', after: 'first' }],
    [{ line: 2, before: 'tw', after: 'partial' }],
    [{ line: 0, before: 'one', after: 'first' }],
    [{ line: 1, before: '', after: 'first' }],
    [{ line: 1, before: 'one', after: 'one' }],
  ];
  for (const output of invalidOutputs) {
    const directory = project(context, `{'maint/deep-control-flow': () => ${JSON.stringify(output)}}`);
    await assert.rejects(attachRecipeFixes([finding], 'recipe.cjs', directory), /Fix recipe maint\/deep-control-flow/);
  }
});

test('validates exports and confines recipe input to the project real path', async (context) => {
  const invalid = project(context, `{ 'maint/deep-control-flow': 'a string' }`);
  await assert.rejects(attachRecipeFixes([finding], 'recipe.cjs', invalid), /Invalid fix recipe/);
  const directory = project(context, `{ 'maint/deep-control-flow': () => null }`);
  const linked = path.join(directory, 'linked');
  fs.symlinkSync(invalid, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    attachRecipeFixes([{ ...finding, file: 'linked/source.txt' }], 'recipe.cjs', directory),
    /outside the current project/,
  );
  await assert.rejects(attachRecipeFixes([finding], 'source.txt', directory), /explicitly named .cjs/);
});
