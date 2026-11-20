'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

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
  const findings = fixesFor(context, ruleId, source);
  assert.ok(findings.length > 0, 'rule should report');
  assert.deepEqual(
    findings.map((finding) => finding.fix),
    findings.map(() => undefined),
  );
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

test('a named fs import becomes the fs/promises name with an import note', (context) => {
  const { change, note } = changeFor(
    context,
    fsRule,
    `import { writeFileSync } from 'fs';
export async function save(path: string, body: string) {
  writeFileSync(path, body);
}`,
  );
  assert.deepEqual(change, { before: 'writeFileSync(path, body);', after: 'await writeFile(path, body);' });
  assert.equal(note, "Import `writeFile` from 'node:fs/promises'.");
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
    before: "const text = load(path, 'utf8');",
    after: "const text = await readFile(path, 'utf8');",
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
  assert.deepEqual(change, { before: 'return readFileSync(path);', after: 'return await readFile(path);' });
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

test('zlib namespace call is promisified with a promisify note', (context) => {
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
    before: 'const packed = zlib.gzipSync(buffer, { level: 9 });',
    after: 'const packed = await promisify(zlib.gzip)(buffer, { level: 9 });',
  });
  assert.equal(note, "Import `promisify` from 'node:util'.");
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

test('a named zlib import needs both imports noted', (context) => {
  const { change, note } = changeFor(
    context,
    zlibRule,
    `import { deflateSync } from 'zlib';
export async function pack(buffer: Buffer) {
  return deflateSync(buffer);
}`,
  );
  assert.deepEqual(change, {
    before: 'return deflateSync(buffer);',
    after: 'return await promisify(deflate)(buffer);',
  });
  assert.equal(note, "Import `deflate` from 'node:zlib'. Import `promisify` from 'node:util'.");
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
    before: 'const key = crypto.scryptSync(password, salt, 64);',
    after: 'const key = await promisify(crypto.scrypt)(password, salt, 64);',
  });
  const second = changeFor(
    context,
    cryptoRule,
    `import * as crypto from 'node:crypto';
export async function derive(password: string, salt: Buffer) {
  return crypto.pbkdf2Sync(password, salt, 1000, 32, 'sha256');
}`,
  );
  assert.equal(second.change.after, "return await promisify(crypto.pbkdf2)(password, salt, 1000, 32, 'sha256');");
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
    before: "execSync('npm run build', { cwd: directory });",
    after: "await promisify(exec)('npm run build', { cwd: directory });",
  });
  assert.equal(
    note,
    "Import `exec` from 'node:child_process'. Import `promisify` from 'node:util'. Output is no longer forwarded to the parent stderr.",
  );
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
    before: "cp.execFileSync('git', ['status']);",
    after: "await promisify(cp.execFile)('git', ['status']);",
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
