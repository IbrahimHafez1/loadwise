'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { applyFixes } = require('../../lib/performance/fix-cli.cjs');
const { scanWithFixes, dedent } = require('./site-fix-helpers.cjs');

// The fix adds the size constant after the imports and then edits the call, as two hunks.
function callChange(finding) {
  assert.equal(finding.fix.changes.length, 2);
  const [declaration, call] = finding.fix.changes;
  assert.ok(declaration.after.includes('const MAX_UPLOAD_FILE_SIZE_BYTES = 10 * 1024 * 1024;'));
  return { before: dedent(call.before), after: dedent(call.after) };
}

const files = {
  'node_modules/@nestjs/platform-express/index.d.ts': `
    export declare function FileInterceptor(field: string, options?: any): any;
    export declare function FilesInterceptor(field: string, max?: number, options?: any): any;
    export declare function AnyFilesInterceptor(options?: any): any;
  `,
  'node_modules/multer/index.d.ts': `declare function multer(options?: any): any;\nexport default multer;`,
  'node_modules/other/index.d.ts': `export declare function FileInterceptor(field: string): any;`,
};

function scan(context, source) {
  return scanWithFixes(context, { ...files, 'src/app.ts': source }).findings.filter(
    (finding) => finding.ruleId === 'upload-without-size-limit',
  );
}

test('previews the upload size policy and leaves the endpoint unchanged under --fix --yes', async (context) => {
  const source = `import { FileInterceptor } from '@nestjs/platform-express';\nexport const a = FileInterceptor('file');\n`;
  const findings = scan(context, source);
  assert.equal(findings.length, 1);
  assert.equal(
    callChange(findings[0]).after,
    `export const a = FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_FILE_SIZE_BYTES } });`,
  );
  assert.equal(findings[0].fix.requiresReview, true);
  assert.match(findings[0].fix.note, /placeholder.*real upload/);
  await applyFixes(findings, { all: true });
  assert.equal(fs.readFileSync(findings[0].file, 'utf8'), source);
});

test('adds limits to a literal without them, and fileSize to limits without it', (context) => {
  const findings = scan(
    context,
    `import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
export const a = FileInterceptor('file', { dest: 'x' });
export const b = FilesInterceptor('files', 3, { limits: { files: 3 } });
`,
  );
  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding) => finding.fix.requiresReview));
  assert.match(callChange(findings[0]).after, /\{ dest: 'x', limits: \{ fileSize: MAX_UPLOAD_FILE_SIZE_BYTES \} \}/);
  assert.match(callChange(findings[1]).after, /\{ limits: \{ files: 3, fileSize: MAX_UPLOAD_FILE_SIZE_BYTES \} \}/);
});

test('adds the property on its own line in a multi-line literal', (context) => {
  const findings = scan(
    context,
    `import { FileInterceptor } from '@nestjs/platform-express';
export const a = FileInterceptor('file', {
  dest: 'x',
});
`,
  );
  assert.match(callChange(findings[0]).after, /dest: 'x',\nlimits: \{ fileSize: MAX_UPLOAD_FILE_SIZE_BYTES \},/);
});

test('reports multer() without limits', (context) => {
  const findings = scan(context, `import multer from 'multer';\nexport const upload = multer();\n`);
  assert.equal(findings.length, 1);
});

test('skips fileSize, spreads, non-literal options and unrelated packages', (context) => {
  const findings = scan(
    context,
    `import { FileInterceptor, AnyFilesInterceptor } from '@nestjs/platform-express';
import { FileInterceptor as Other } from 'other';
const shared = {};
export const a = FileInterceptor('file', { limits: { fileSize: 5 } });
export const b = FileInterceptor('file', { ...shared });
export const c = FileInterceptor('file', shared);
export const d = Other('file');
export const e = AnyFilesInterceptor({ limits: shared });
`,
  );
  assert.equal(findings.length, 0);
});
