'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lintBothWays, lintWithoutTypes, stubs } = require('./helpers.cjs');

const ruleId = 'path-traversal';

function expressRoute(body, preamble = '') {
  return [
    "import express from 'express';",
    "import path from 'path';",
    "import fs from 'fs';",
    "import { readFile } from 'fs/promises';",
    preamble,
    'const app = express();',
    `app.get('/files/:name', async (req, res) => { ${body} });`,
  ].join('\n');
}

function findings(source, files = stubs.express) {
  return lintBothWays(source, files).typed.filter((finding) => finding.ruleId === ruleId);
}

test('a request value in an fs path or a rootless sendFile is reported', () => {
  const [direct] = findings(expressRoute("await readFile(path.join('/srv/files', req.params.name));"));
  assert.match(direct.message, /includes `req\.params\.name`/);
  assert.equal(direct.contextualReason, undefined);
  assert.equal(findings(expressRoute('const name = req.query.file; fs.createReadStream(`/srv/${name}`);')).length, 1);
  assert.equal(findings(expressRoute("fs.promises.unlink('/srv/' + req.body.name);")).length, 1);
  assert.equal(findings(expressRoute("fs.renameSync('/tmp/a', path.resolve('/srv', req.body.to));")).length, 1);
  assert.equal(findings(expressRoute('res.sendFile(path.join(__dirname, req.params.name));')).length, 1);
  assert.equal(findings(expressRoute('res.render(req.query.view as string);')).length, 1);
});

test('basename, a containment check, a root option and server paths are not reported', () => {
  assert.equal(findings(expressRoute("await readFile(path.join('/srv', path.basename(req.params.name)));")).length, 0);
  const contained = [
    "const full = path.resolve('/srv/files', req.params.name);",
    "if (!full.startsWith('/srv/files' + path.sep)) return res.status(400).end();",
    'await readFile(full);',
  ].join(' ');
  assert.equal(findings(expressRoute(contained)).length, 0);
  const relative = [
    "const full = path.resolve('/srv', req.params.name);",
    "const relative = path.relative('/srv', full);",
    "if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside');",
    'fs.readFileSync(full);',
  ].join(' ');
  assert.equal(findings(expressRoute(relative)).length, 0);
  const separateParent = relative.replace(
    "relative.startsWith('..')",
    "relative === '..' || relative.startsWith('..' + path.sep)",
  );
  assert.equal(findings(expressRoute(separateParent)).length, 0);
  const checkedHelper =
    "function storagePath(key: string) { if (key.includes('..')) throw new Error('bad key'); return path.join('/srv', key); }";
  assert.equal(
    findings(expressRoute('const full = storagePath(req.params.name); fs.readFileSync(full);', checkedHelper)).length,
    1,
  );
  const plainHelper = "function storagePath(key: string) { return path.join('/srv', key); }";
  assert.equal(
    findings(expressRoute('const full = storagePath(req.params.name); fs.readFileSync(full);', plainHelper)).length,
    1,
  );
  assert.equal(findings(expressRoute("res.sendFile(req.params.name, { root: 'public' });")).length, 0);
  assert.equal(findings(expressRoute("await readFile(path.join('/srv', String(Number(req.params.name))));")).length, 0);
  assert.equal(findings(expressRoute("await readFile(path.join('/srv', req.user.id));")).length, 0);
  assert.equal(findings(expressRoute('storage.download(req.params.name);', 'declare const storage: any;')).length, 0);
  assert.equal(findings(expressRoute('cache.readFile(req.params.name);', 'declare const cache: any;')).length, 0);
});

test('only directory checks that govern the same resolved path quiet a finding', () => {
  const resolved = "const full = path.resolve('/srv/files', req.params.name);";
  const guard = "if (!full.startsWith('/srv/files' + path.sep)) return;";
  const read = 'await readFile(full);';
  for (const body of [
    `${resolved} ${read} ${guard}`,
    `${resolved} if (!full.startsWith('/srv/files')) return; ${read}`,
    `${resolved} if (full.startsWith('/srv/files' + path.sep)) return; ${read}`,
    `${resolved} if (!full.startsWith('/srv/files' + path.sep)) console.warn(full); ${read}`,
    `${resolved} if (path.relative('/srv/files', full).startsWith('..')) return; ${read}`,
    `${resolved} if (!full.startsWith('/another/location' + path.sep)) return; ${read}`,
  ]) {
    assert.equal(findings(expressRoute(body)).length, 1, body);
  }
  assert.equal(
    findings(expressRoute(`${resolved} if (full.startsWith('/srv/files' + path.sep)) { ${read} }`)).length,
    0,
  );
});

test('an uploaded file name is contextual and the multer path is clean', () => {
  const source = [
    "import { Controller, Post, UploadedFile } from '@nestjs/common';",
    "import { writeFile } from 'fs/promises';",
    '@Controller() class Uploads {',
    "  @Post() save(@UploadedFile() file: any) { return writeFile('/srv/' + file.originalname, file.buffer); }",
    "  @Post() move(@UploadedFile() file: any) { return writeFile(file.path + '.bak', file.buffer); }",
    '}',
  ].join('\n');
  const result = lintWithoutTypes(source, stubs.nest).filter((finding) => finding.ruleId === ruleId);
  assert.deepEqual(
    result.map((finding) => [finding.line, Boolean(finding.contextualReason)]),
    [[4, true]],
  );
  assert.match(result[0].contextualReason, /multer/);
});
