import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const libraryFolder = path.join(__dirname, '..', '..', 'lib', 'performance');
const adapterText = fs.readFileSync(path.join(libraryFolder, 'native-checker.cjs'), 'utf8');

test('every type checker method a rule calls exists on the native checker adapter', () => {
  const missing = new Set();
  for (const fileName of fs.readdirSync(libraryFolder).filter((name) => name.endsWith('.cjs'))) {
    const text = fs.readFileSync(path.join(libraryFolder, fileName), 'utf8');
    for (const [, method] of text.matchAll(/\bchecker\.(\w+)\(/g)) {
      if (!adapterText.includes(method)) missing.add(`${fileName}: ${method}`);
    }
  }
  assert.deepEqual([...missing], []);
});
