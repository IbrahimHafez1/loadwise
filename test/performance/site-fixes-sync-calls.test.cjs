'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertReportedWithoutFix, scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const bcryptTypes = `
  export function hashSync(data: string, rounds: number): string;
  export function compareSync(data: string, hash: string): boolean;
  export function genSaltSync(rounds?: number): string;
  export function hash(data: string, rounds: number): Promise<string>;
  export function compare(data: string, hash: string): Promise<boolean>;
  export function genSalt(rounds?: number): Promise<string>;
`;
const stubs = {
  'node_modules/bcrypt/index.d.ts': bcryptTypes,
  'node_modules/bcryptjs/index.d.ts': bcryptTypes,
};

function fixesFor(context, ruleId, source) {
  const { findings } = scanWithFixes(context, { 'app.ts': source, ...stubs });
  return findings.filter((finding) => finding.ruleId === ruleId);
}

function changeFor(context, ruleId, source) {
  const [finding] = fixesFor(context, ruleId, source);
  assert.ok(finding, 'rule should report');
  return { change: onlyChange(finding), note: finding.fix?.note };
}

function assertNoFix(context, ruleId, source) {
  assertReportedWithoutFix(fixesFor(context, ruleId, source));
}

const fsRule = 'node-sync-fs-in-async';
const zlibRule = 'node-sync-compression-in-async';
const cryptoRule = 'node-sync-crypto-in-async';
const processRule = 'node-sync-process-in-async';
const bcryptRule = 'password-hash-sync-in-async';

test('fs namespace import uses fs.promises with the same arguments', (context) => {
  const { change, note } = changeFor(
    context,
    fsRule,
    `import fs from 'node:fs';
export async function save(path: string, body: string) {
  fs.writeFileSync(path, body, 'utf8');
}`,
  );
  assert.deepEqual(change, {
    before: "fs.writeFileSync(path, body, 'utf8');",
    after: "await fs.promises.writeFile(path, body, 'utf8');",
  });
  assert.equal(note, undefined);
});

test('star import and an assigned result are rewritten', (context) => {
  const { change } = changeFor(
    context,
    fsRule,
    `import * as disk from 'fs';
export async function load(path: string) {
  const text = disk.readFileSync(path, 'utf8');
  return text;
}`,
  );
  assert.deepEqual(change, {
    before: "const text = disk.readFileSync(path, 'utf8');",
    after: "const text = await disk.promises.readFile(path, 'utf8');",
  });
});

test('a member access on the result is parenthesized', (context) => {
  const { change } = changeFor(
    context,
    fsRule,
    `import fs from 'fs';
export async function load(path: string) {
  return fs.readFileSync(path).toString();
}`,
  );
  assert.deepEqual(change, {
    before: 'return fs.readFileSync(path).toString();',
    after: 'return (await fs.promises.readFile(path)).toString();',
  });
});

test('a call that is itself called or indexed is parenthesized', (context) => {
  const { change } = changeFor(
    context,
    fsRule,
    `import fs from 'fs';
export async function names(dir: string) {
  return fs.readdirSync(dir)[0];
}`,
  );
  assert.deepEqual(change, {
    before: 'return fs.readdirSync(dir)[0];',
    after: 'return (await fs.promises.readdir(dir))[0];',
  });
});

test('a named fs import that only this call used is swapped for the fs/promises import', (context) => {
  const { change, note } = changeFor(
    context,
    fsRule,
    `import { writeFileSync } from 'fs';
export async function save(path: string, body: string) {
  writeFileSync(path, body);
}`,
  );
  assert.deepEqual(change, {
    before: `import { writeFileSync } from 'fs';
export async function save(path: string, body: string) {
  writeFileSync(path, body);`,
    after: `import { writeFile } from 'fs/promises';
export async function save(path: string, body: string) {
  await writeFile(path, body);`,
  });
  assert.equal(note, undefined);
});

test('a require binding keeps its other names and gains the promise require in the same style', (context) => {
  const { findings } = scanWithFixes(context, {
    'app.js': [
      'const { existsSync, writeFileSync } = require("node:fs")',
      '',
      '',
      '',
      'exports.save = async function (path, body) {',
      '  if (existsSync(path)) return',
      '  writeFileSync(path, body)',
      '}',
      '',
    ].join('\r\n'),
  });
  // existsSync has no promise twin, so only the writeFileSync call on line 7 is rewritten.
  const finding = findings.find((candidate) => candidate.ruleId === fsRule && candidate.line === 7);
  assert.ok(finding?.fix, 'rule should report a fix');
  assert.deepEqual(
    finding.fix.changes.map((change) => change.after),
    [
      'const { existsSync } = require("node:fs")\nconst { writeFile } = require("node:fs/promises")',
      '  await writeFile(path, body)',
    ],
  );
  assert.equal(finding.fix.note, undefined);
});

test('a named fs import still used elsewhere stays, and the fix adds the promise import', (context) => {
  const { findings } = scanWithFixes(context, {
    'app.ts': `import { writeFileSync } from 'fs';
export const writer = writeFileSync;
export async function save(path: string, body: string) {
  writeFileSync(path, body);
}`,
  });
  const finding = findings.find((candidate) => candidate.ruleId === fsRule);
  assert.deepEqual(onlyChange(finding), {
    before: `import { writeFileSync } from 'fs';
export const writer = writeFileSync;
export async function save(path: string, body: string) {
  writeFileSync(path, body);`,
    after: `import { writeFileSync } from 'fs';
import { writeFile } from 'fs/promises';
export const writer = writeFileSync;
export async function save(path: string, body: string) {
  await writeFile(path, body);`,
  });
  assert.equal(finding.fix.note, undefined);
});

test('an aliased named import still maps to the promise name', (context) => {
  const { change } = changeFor(
    context,
    fsRule,
    `import { readFileSync as load } from 'node:fs';
export async function read(path: string) {
  const text = load(path, 'utf8');
  return text;
}`,
  );
  assert.deepEqual(change, {
    before: `import { readFileSync as load } from 'node:fs';
export async function read(path: string) {
  const text = load(path, 'utf8');`,
    after: `import { readFile } from 'node:fs/promises';
export async function read(path: string) {
  const text = await readFile(path, 'utf8');`,
  });
});

test('a named import whose promise name is already imported needs no note', (context) => {
  const { change, note } = changeFor(
    context,
    fsRule,
    `import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
export async function read(path: string) {
  return readFileSync(path);
}`,
  );
  assert.deepEqual(change, {
    before: `import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
export async function read(path: string) {
  return readFileSync(path);`,
    after: `import { readFile } from 'fs/promises';
export async function read(path: string) {
  return await readFile(path);`,
  });
  assert.equal(note, undefined);
});

test('no fix when the promise name is taken by something else', (context) => {
  assertNoFix(
    context,
    fsRule,
    `import { readFileSync } from 'fs';
const readFile = (path: string) => path;
export async function read(path: string) {
  readFile(path);
  return readFileSync(path);
}`,
  );
});

test('no fix for existsSync, fd calls, stat options or a nested sync function', (context) => {
  assertNoFix(
    context,
    fsRule,
    `import fs from 'fs';
export async function check(path: string, fd: number) {
  fs.existsSync(path);
  fs.readFileSync(0);
  fs.writeFileSync(fd, 'x');
  fs.statSync(path, { throwIfNoEntry: false });
  [1].map(() => fs.readFileSync(path));
}`,
  );
});

test('no fix when the call is awaited already or the function is not the async one', (context) => {
  assertNoFix(
    context,
    fsRule,
    `import fs from 'fs';
export async function load(path: string) {
  (function inner() {
    fs.readFileSync(path);
  })();
}`,
  );
});

test('zlib namespace call is promisified and imports promisify', (context) => {
  const { change, note } = changeFor(
    context,
    zlibRule,
    `import zlib from 'zlib';
export async function pack(buffer: Buffer) {
  const packed = zlib.gzipSync(buffer, { level: 9 });
  return packed;
}`,
  );
  assert.deepEqual(change, {
    before: `import zlib from 'zlib';
export async function pack(buffer: Buffer) {
  const packed = zlib.gzipSync(buffer, { level: 9 });`,
    after: `import zlib from 'zlib';
import { promisify } from 'util';
export async function pack(buffer: Buffer) {
  const packed = await promisify(zlib.gzip)(buffer, { level: 9 });`,
  });
  assert.equal(note, undefined);
});

test('an existing promisify import suppresses the note and parentheses are added for member access', (context) => {
  const { change, note } = changeFor(
    context,
    zlibRule,
    `import { promisify } from 'util';
import * as zlib from 'node:zlib';
export async function unpack(buffer: Buffer) {
  return zlib.gunzipSync(buffer).toString();
}`,
  );
  assert.deepEqual(change, {
    before: 'return zlib.gunzipSync(buffer).toString();',
    after: 'return (await promisify(zlib.gunzip)(buffer)).toString();',
  });
  assert.equal(note, undefined);
});

test('a named zlib import gains both imports', (context) => {
  const { change, note } = changeFor(
    context,
    zlibRule,
    `import { deflateSync } from 'zlib';
export async function pack(buffer: Buffer) {
  return deflateSync(buffer);
}`,
  );
  assert.deepEqual(change, {
    before: `import { deflateSync } from 'zlib';
export async function pack(buffer: Buffer) {
  return deflateSync(buffer);`,
    after: `import { deflateSync } from 'zlib';
import { deflate } from 'zlib';
import { promisify } from 'util';
export async function pack(buffer: Buffer) {
  return await promisify(deflate)(buffer);`,
  });
  assert.equal(note, undefined);
});

test('no zlib fix when promisify is a different binding', (context) => {
  assertNoFix(
    context,
    zlibRule,
    `import zlib from 'zlib';
import { promisify } from './local';
export async function pack(buffer: Buffer) {
  return zlib.gzipSync(buffer);
}`,
  );
});

test('crypto scryptSync and pbkdf2Sync use their callback forms', (context) => {
  const { change } = changeFor(
    context,
    cryptoRule,
    `import crypto from 'crypto';
export async function derive(password: string, salt: Buffer) {
  const key = crypto.scryptSync(password, salt, 64);
  return key;
}`,
  );
  assert.deepEqual(change, {
    before: `import crypto from 'crypto';
export async function derive(password: string, salt: Buffer) {
  const key = crypto.scryptSync(password, salt, 64);`,
    after: `import crypto from 'crypto';
import { promisify } from 'util';
export async function derive(password: string, salt: Buffer) {
  const key = await promisify(crypto.scrypt)(password, salt, 64);`,
  });
  const second = changeFor(
    context,
    cryptoRule,
    `import * as crypto from 'node:crypto';
export async function derive(password: string, salt: Buffer) {
  return crypto.pbkdf2Sync(password, salt, 1000, 32, 'sha256');
}`,
  );
  assert.equal(
    second.change.after,
    `import * as crypto from 'node:crypto';
import { promisify } from 'node:util';
export async function derive(password: string, salt: Buffer) {
  return await promisify(crypto.pbkdf2)(password, salt, 1000, 32, 'sha256');`,
  );
});

test('execSync with a discarded result becomes promisified exec', (context) => {
  const { change, note } = changeFor(
    context,
    processRule,
    `import { execSync } from 'child_process';
export async function build(directory: string) {
  execSync('npm run build', { cwd: directory });
}`,
  );
  assert.deepEqual(change, {
    before: `import { execSync } from 'child_process';
export async function build(directory: string) {
  execSync('npm run build', { cwd: directory });`,
    after: `import { execSync } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';
export async function build(directory: string) {
  await promisify(exec)('npm run build', { cwd: directory });`,
  });
  assert.equal(note, 'Output is no longer forwarded to the parent stderr.');
});

test('execFileSync through a namespace keeps the argument array', (context) => {
  const { change } = changeFor(
    context,
    processRule,
    `import cp from 'node:child_process';
export async function run() {
  cp.execFileSync('git', ['status']);
}`,
  );
  assert.deepEqual(change, {
    before: `import cp from 'node:child_process';
export async function run() {
  cp.execFileSync('git', ['status']);`,
    after: `import cp from 'node:child_process';
import { promisify } from 'node:util';
export async function run() {
  await promisify(cp.execFile)('git', ['status']);`,
  });
});

test('no process fix when the result is used, stdio is set or the call is spawnSync', (context) => {
  assertNoFix(
    context,
    processRule,
    `import { execSync, spawnSync } from 'child_process';
export async function run() {
  const output = execSync('ls');
  execSync('ls', { stdio: 'inherit' });
  spawnSync('ls');
  return output;
}`,
  );
});

test('bcrypt namespace calls become the async methods', (context) => {
  const { change, note } = changeFor(
    context,
    bcryptRule,
    `import * as bcrypt from 'bcrypt';
export async function login(password: string, stored: string) {
  const ok = bcrypt.compareSync(password, stored);
  return ok;
}`,
  );
  assert.deepEqual(change, {
    before: 'const ok = bcrypt.compareSync(password, stored);',
    after: 'const ok = await bcrypt.compare(password, stored);',
  });
  assert.equal(note, undefined);
});

test('bcryptjs default import and a hashed argument keep the receiver', (context) => {
  const { change } = changeFor(
    context,
    bcryptRule,
    `import bcryptjs from 'bcryptjs';
export async function register(password: string) {
  return bcryptjs.hashSync(password, 10);
}`,
  );
  assert.deepEqual(change, {
    before: 'return bcryptjs.hashSync(password, 10);',
    after: 'return await bcryptjs.hash(password, 10);',
  });
});

test('a named bcrypt import is renamed with an import note', (context) => {
  const { change, note } = changeFor(
    context,
    bcryptRule,
    `import { hashSync } from 'bcrypt';
export async function register(password: string) {
  return hashSync(password, 10);
}`,
  );
  assert.deepEqual(change, { before: 'return hashSync(password, 10);', after: 'return await hash(password, 10);' });
  assert.equal(note, "Import `hash` from 'bcrypt'.");
});

test('no bcrypt fix in a sync request handler', (context) => {
  assertNoFix(
    context,
    bcryptRule,
    `import * as bcrypt from 'bcrypt';
export function handler(req: { body: string }) {
  return bcrypt.hashSync(req.body, 10);
}`,
  );
});

test('no bcrypt fix when the receiver is not the module', (context) => {
  assertNoFix(
    context,
    bcryptRule,
    `import { hashSync } from 'bcrypt';
const lib = { hashSync };
export async function register(password: string) {
  return lib.hashSync(password, 10);
}`,
  );
});

test('bcrypt inside a map callback of an async function hashes in parallel under Promise.all', (context) => {
  const { change, note } = changeFor(
    context,
    bcryptRule,
    `import * as bcrypt from 'bcrypt';
export async function seed(keys: string[], roleId: string | null) {
  const owners = keys.map((key) => ({
    id: key,
    password: bcrypt.hashSync(key, 10),
    roleId: roleId ?? null,
  }));
  return owners;
}`,
  );
  assert.deepEqual(change, {
    before: `const owners = keys.map((key) => ({
  id: key,
  password: bcrypt.hashSync(key, 10),
  roleId: roleId ?? null,
}));`,
    after: `const owners = await Promise.all(keys.map(async (key) => ({
  id: key,
  password: await bcrypt.hash(key, 10),
  roleId: roleId ?? null,
})));`,
  });
  assert.match(note, /Promise\.all/);
});

test('no bcrypt map fix when the callback has effects after the hash or the map is not in the async function', (context) => {
  assertNoFix(
    context,
    bcryptRule,
    `import * as bcrypt from 'bcrypt';
export async function seed(keys: string[], log: (key: string) => void) {
  return keys.map((key) => ({ password: bcrypt.hashSync(key, 10), logged: log(key) }));
}`,
  );
  assertNoFix(
    context,
    bcryptRule,
    `import * as bcrypt from 'bcrypt';
export async function seed(keys: string[]) {
  const build = () => keys.map((key) => bcrypt.hashSync(key, 10));
  return build();
}`,
  );
});
