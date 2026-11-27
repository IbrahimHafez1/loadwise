import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintBothWays, lintWithoutTypes, stubs } from './helpers.js';
import type { LocatedFinding } from '../types/security.js';

const ruleId = 'path-traversal';

function expressRoute(body: string, preamble = '') {
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

function findings(source: string, files = stubs.express) {
  return lintBothWays(source, files).typed.filter((finding: LocatedFinding) => finding.ruleId === ruleId);
}

test('a checked match for an anchored filename format validates the original filename', () => {
  const body = [
    'const filename = req.params.name;',
    'const match = allowedName.exec(filename);',
    'if (!match) return;',
    "await readFile(path.join('/srv/files', filename));",
  ].join('\n');
  const result = findings(expressRoute(body, 'const allowedName = /^([0-9]+)-[a-f0-9-]{36}\\.(pdf|png|jpg)$/;'));
  assert.equal(result.length, 0);
});

test('a filename guard must establish a closed format for the exact value reaching the path', () => {
  const guarded = (pattern: string, condition = 'if (!match) return;', extra = '') =>
    expressRoute(
      `const name = req.params.name; const match = pattern.exec(name); ${condition} await readFile(path.join('/srv', name));`,
      `const pattern = ${pattern}; ${extra}`,
    );
  assert.equal(findings(guarded('/^[A-Z0-9_-]+\\.pdf$/i')).length, 0);
  const byTest = (pattern: string) =>
    expressRoute(
      `const name = req.params.name; if (!${pattern}.test(name)) return; await readFile(path.join('/srv', name));`,
    );
  assert.equal(findings(byTest('/^[a-z]+$/')).length, 0);
  assert.equal(findings(byTest('/^[A-z]+$/')).length, 1);
  for (const pattern of ['/^[A-z]+$/', '/^[a-z]+.pdf$/', '/^[a-z]+$/m', '/[a-z]+$/', '/^a|b$/']) {
    assert.equal(findings(guarded(pattern)).length, 1, pattern);
  }
  assert.equal(findings(guarded('/^[a-z]+$/', 'if (!match) console.info("invalid");')).length, 1);
  assert.equal(findings(guarded('/^[a-z]+$/', 'if (match) return;')).length, 1);
  assert.equal(findings(guarded('/^[a-z]+$/', 'if (!match) return;', 'configureMatcher(pattern);')).length, 1);
  const checkedOther =
    "const name = req.params.name; if (!/^[a-z]+$/.exec(req.params.other)) return; await readFile(path.join('/srv', name));";
  assert.equal(findings(expressRoute(checkedOther)).length, 1);
  const changedName =
    'function open(name: string, other: string) { const match = /^[a-z]+$/.exec(name); if (!match) return; [name] = [other]; fs.readFileSync(name); }';
  assert.equal(findings(expressRoute('open(req.params.name, req.params.other);', changedName)).length, 1);
});

test('a request value in an fs path or a rootless sendFile is reported', () => {
  const [direct] = findings(expressRoute("await readFile(path.join('/srv/files', req.params.name));"));
  assert.match(direct.message, /includes `req\.params\.name`/);
  assert.equal(direct.contextualReason, undefined);
  assert.equal(findings(expressRoute('const name = req.query.file; fs.createReadStream(`/srv/${name}`);')).length, 1);
  assert.equal(findings(expressRoute("fs.promises.unlink('/srv/' + req.body.name);")).length, 1);
  assert.equal(findings(expressRoute("fs.renameSync('/tmp/a', path.resolve('/srv', req.body.to));")).length, 1);
  assert.equal(findings(expressRoute('res.sendFile(path.join(import.meta.dirname, req.params.name));')).length, 1);
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
  const result = lintWithoutTypes(source, stubs.nest).filter((finding: LocatedFinding) => finding.ruleId === ruleId);
  assert.deepEqual(
    result.map((finding: LocatedFinding) => [finding.line, Boolean(finding.contextualReason)]),
    [[4, true]],
  );
  assert.match(result[0].contextualReason ?? '', /multer/);
});
