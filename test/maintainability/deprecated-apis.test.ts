import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { checkDeprecatedApis } from '../../lib/maintainability/deprecated-apis.js';
import { buildFix } from '../../lib/maintainability/site-fix.js';
import { applyFix } from '../../lib/maintainability/apply-fix.js';

function scan(text: string, file = 'sample.ts') {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return { sourceFile, findings: checkDeprecatedApis(sourceFile, file) };
}

function fixed(text: string) {
  const { sourceFile, findings } = scan(text);
  const entry = {
    text,
    sourceFile,
    absolute: 'sample.ts',
    filename: 'sample.ts',
    lineStarts: [...sourceFile.getLineStarts()],
    scriptKind: sourceFile.scriptKind,
  };
  return findings.map((finding) => {
    const fix = buildFix(finding, () => entry, { comments: false });
    if (!fix) return undefined;
    let after = text;
    applyFix(fix, { readFile: () => text, writeFile: (_file, value) => (after = value) });
    return { after, requiresReview: Boolean(fix.requiresReview) };
  });
}

test('flags new Buffer and Buffer calls', () => {
  assert.equal(scan('const a = new Buffer(10);\nconst b = Buffer(x);\n').findings.length, 2);
  assert.equal(scan('const a = Buffer.alloc(10);\n').findings.length, 0);
});

test('does not flag a Buffer the file declares itself or one imported from node:buffer', () => {
  assert.equal(scan('function f(Buffer) { return new Buffer(1); }\n').findings.length, 0);
  assert.equal(scan("import { Buffer } from 'node:buffer';\nconst a = new Buffer(1);\n").findings.length, 1);
});

test('flags url.parse in each way the module can be bound', () => {
  const sources = [
    "import url from 'url';\nurl.parse(x);\n",
    "import * as u from 'node:url';\nu.parse(x);\n",
    "import { parse as p } from 'url';\np(x);\n",
    "const { parse } = require('url');\nparse(x);\n",
    "const u = require('node:url');\nu.parse(x);\n",
    "require('url').parse(x);\n",
  ];
  for (const source of sources) assert.equal(scan(source).findings.length, 1, source);
});

test('flags fs.exists but not existsSync, fs/promises or unrelated parse calls', () => {
  assert.equal(scan("import fs from 'node:fs';\nfs.exists(p, cb);\n").findings.length, 1);
  assert.equal(scan("import { exists } from 'fs';\nexists(p, cb);\n").findings.length, 1);
  assert.equal(scan("import fs from 'fs';\nfs.existsSync(p);\n").findings.length, 0);
  assert.equal(scan("import fs from 'fs/promises';\nfs.exists(p);\n").findings.length, 0);
  assert.equal(scan("import fs from 'fs-extra';\nfs.exists(p);\n").findings.length, 0);
  assert.equal(scan('JSON.parse(text);\nconst parse = (v) => v;\nparse(1);\n').findings.length, 0);
});

test('names the replacement in the message', () => {
  const [buffer] = scan('new Buffer(1);\n').findings;
  assert.match(buffer.message, /Buffer\.alloc/);
  const [exists] = scan("import fs from 'fs';\nfs.exists(p, cb);\n").findings;
  assert.match(exists.message, /existsSync/);
  assert.equal(buffer.line, 1);
  assert.equal(buffer.column, 1);
});

test('rewrites new Buffer only when a literal shows alloc or from', () => {
  assert.equal(fixed('const a = new Buffer(16);\n')[0]?.after, 'const a = Buffer.alloc(16);\n');
  assert.equal(fixed("const a = new Buffer('hi', 'utf8');\n")[0]?.after, "const a = Buffer.from('hi', 'utf8');\n");
  assert.equal(fixed('const a = Buffer([1, 2]);\n')[0]?.after, 'const a = Buffer.from([1, 2]);\n');
  assert.equal(fixed('const a = new Buffer(size);\n')[0], undefined);
});

test('rewrites url.parse to new URL for review, and leaves fs.exists alone', () => {
  assert.deepEqual(fixed("import url from 'url';\nconst a = url.parse(input).host;\n")[0], {
    after: "import url from 'url';\nconst a = new URL(input).host;\n",
    requiresReview: true,
  });
  assert.equal(fixed("import url from 'url';\nurl.parse(input, true);\n")[0], undefined);
  assert.equal(fixed("import fs from 'fs';\nfs.exists(p, cb);\n")[0], undefined);
});

test('a parameter or local that shadows the imported name is not the deprecated API', () => {
  const urlShadowed =
    "import url from 'node:url';\nfunction a(url: { parse(input: string): number }) { return url.parse('x'); }\n";
  const existsShadowed =
    "import { exists } from 'node:fs';\nfunction b(exists: (path: string) => boolean) { return exists('p'); }\n";
  assert.deepEqual(scan(urlShadowed).findings, []);
  assert.deepEqual(scan(existsShadowed).findings, []);
  assert.deepEqual(fixed(urlShadowed), []);
});

test('an unshadowed import is still reported next to code that never names it', () => {
  assert.equal(scan("import url from 'node:url';\nurl.parse(input);\n").findings.length, 1);
  assert.deepEqual(scan("const text = 'nothing deprecated here';\n").findings, []);
});
