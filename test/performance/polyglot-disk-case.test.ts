import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { diskCasedPath } from '../../lib/performance/polyglot.js';

test('diskCasedPath keeps the given name of a symlinked directory whose target differs only by case', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-disk-case-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'deps', 'SRC'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'repo'));
  fs.writeFileSync(path.join(directory, 'deps', 'SRC', 'a.py'), '');
  try {
    fs.symlinkSync(path.join(directory, 'deps', 'SRC'), path.join(directory, 'repo', 'src'), 'dir');
  } catch {
    context.skip('symlinks are unavailable here');
    return;
  }
  const input = path.join(directory, 'repo', 'src', 'a.py');
  assert.equal((await diskCasedPath(input)).toLowerCase(), input.toLowerCase());
});
