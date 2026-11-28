import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import requestForgery from '../../lib/security/site-fixes/request-forgery.js';
import injection from '../../lib/security/site-fixes/injection.js';
import exposure from '../../lib/security/site-fixes/exposure.js';
import authCrypto from '../../lib/security/site-fixes/auth-crypto.js';
import jwtFixes from '../../lib/security/site-fixes/jwt.js';
import frontendSecurity from '../../lib/security/site-fixes/frontend-security-fixes.js';
import fileFixes from '../../lib/security/site-fixes/files.js';
import frontendPerf from '../../lib/performance/site-fixes/frontend-fixes.js';
import backendPerf from '../../lib/performance/site-fixes/backend-mastery-fixes.js';
import databasePerf from '../../lib/performance/site-fixes/database.js';
import exportMaint from '../../lib/maintainability/site-fixes/exports.js';
import type { SiteFixBuilder, TextEdit } from '../../lib/shared/types.js';

function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let result = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function nodeAtNeedle(sourceFile: ts.SourceFile, needle: string): ts.Node | undefined {
  const offset = sourceFile.text.indexOf(needle);
  if (offset === -1) return undefined;
  let found: ts.Node | undefined;
  function visit(node: ts.Node): void {
    if (node.getStart(sourceFile) <= offset && offset < node.end) {
      found = node;
      ts.forEachChild(node, visit);
    }
  }
  visit(sourceFile);
  return found;
}

function runBuilder(
  builder: SiteFixBuilder,
  ruleId: string,
  code: string,
  needle: string,
  fileName = 'sample.ts',
): { after: string; requiresReview: boolean } | undefined {
  const isSource = /\.[cm]?[jt]sx?$/.test(fileName);
  const sourceFile = isSource ? ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true) : undefined;
  const node = sourceFile ? nodeAtNeedle(sourceFile, needle) : undefined;
  const line = code.slice(0, Math.max(0, code.indexOf(needle))).split('\n').length;
  const result = builder({
    finding: { ruleId, message: '', file: fileName, line, column: 1 },
    node,
    sourceFile,
    text: code,
    load: () => null,
  });
  if (!result?.edits) return undefined;
  return { after: applyEdits(code, result.edits), requiresReview: Boolean(result.requiresReview) };
}

test('security request-forgery fixers: upload-client-filename, open-redirect, path-traversal + no-op', () => {
  const upload = runBuilder(
    requestForgery['upload-client-filename'],
    'upload-client-filename',
    'const n = file.originalname;\n',
    'originalname',
  );
  assert.ok(upload?.after.includes('path.basename(file.originalname)'));
  assert.equal(
    runBuilder(requestForgery['upload-client-filename'], 'upload-client-filename', 'const n = 1;\n', '1'),
    undefined,
  );

  const redirect = runBuilder(
    requestForgery['open-redirect'],
    'open-redirect',
    'res.redirect(target);\n',
    'res.redirect',
  );
  assert.ok(
    redirect?.requiresReview &&
      redirect.after.includes("typeof target === 'string' && target.startsWith('/') && !target.startsWith('//')"),
  );
  assert.equal(
    runBuilder(requestForgery['open-redirect'], 'open-redirect', 'res.redirect(getTarget());\n', 'res.redirect'),
    undefined,
  );
  assert.equal(
    runBuilder(requestForgery['open-redirect'], 'open-redirect', "res.redirect('/home');\n", 'res.redirect'),
    undefined,
  );

  const traversal = runBuilder(
    requestForgery['path-traversal'],
    'path-traversal',
    'fs.readFileSync(path.join(base, name));\n',
    'fs.readFileSync',
  );
  assert.ok(traversal?.requiresReview && traversal.after.includes('path.basename(name)'));
  const uploadWithReqPath = runBuilder(
    requestForgery['upload-client-filename'],
    'upload-client-filename',
    'const n = req.path + file.originalname;\n',
    'originalname',
  );
  assert.ok(uploadWithReqPath?.after.includes("import path from 'node:path';"));
  const uploadAfterShebang = runBuilder(
    requestForgery['upload-client-filename'],
    'upload-client-filename',
    '#!/usr/bin/env node\nconst n = file.originalname;\n',
    'originalname',
  );
  assert.ok(uploadAfterShebang?.after.startsWith("#!/usr/bin/env node\nimport path from 'node:path';\n"));
  const uploadAfterDirective = runBuilder(
    requestForgery['upload-client-filename'],
    'upload-client-filename',
    "'use server';\nconst n = file.originalname;\n",
    'originalname',
  );
  assert.ok(uploadAfterDirective?.after.startsWith("'use server';\nimport path from 'node:path';\n"));
  assert.equal(
    runBuilder(requestForgery['path-traversal'], 'path-traversal', 'fs.readFileSync(name);\n', 'fs.readFileSync'),
    undefined,
  );
});

test('security injection fixers: regex-from-input, pg, mysql, prisma + no-op', () => {
  const rx = runBuilder(injection['regex-from-input'], 'regex-from-input', 'const re = new RegExp(q);\n', 'new RegExp');
  assert.ok(rx?.after.includes('String(q).replace('));
  assert.equal(
    runBuilder(injection['regex-from-input'], 'regex-from-input', "const re = new RegExp('abc');\n", 'new RegExp'),
    undefined,
  );

  const mysql = runBuilder(
    injection['mysql-dynamic-query-text'],
    'mysql-dynamic-query-text',
    'conn.query(`SELECT * FROM u WHERE id = ${id}`);\n',
    'conn.query',
  );
  assert.ok(mysql?.requiresReview && mysql.after.includes('?') && mysql.after.includes('[id]'));

  const mysqlQuoted = runBuilder(
    injection['mysql-dynamic-query-text'],
    'mysql-dynamic-query-text',
    "conn.query(`SELECT * FROM u WHERE id = '${id}'`);\n",
    'conn.query',
  );
  assert.ok(mysqlQuoted?.requiresReview && mysqlQuoted.after.includes('"SELECT * FROM u WHERE id = ?", [id]'));

  assert.equal(
    runBuilder(
      injection['mysql-dynamic-query-text'],
      'mysql-dynamic-query-text',
      "conn.query(`SELECT * FROM u WHERE id = '${id}`);\n",
      'conn.query',
    ),
    undefined,
  );

  const prisma = runBuilder(
    injection['prisma-raw-unsafe-dynamic'],
    'prisma-raw-unsafe-dynamic',
    'prisma.$queryRawUnsafe(`SELECT * FROM u WHERE id = ${id}`);\n',
    'prisma.$queryRawUnsafe',
  );
  assert.ok(prisma?.requiresReview && prisma.after.includes('prisma.$queryRaw`'));
});

test('security exposure, auth-crypto, jwt, frontend, and files fixers + idempotency', () => {
  const cors = runBuilder(
    exposure['cors-credentials-any-origin'],
    'cors-credentials-any-origin',
    "cors({ origin: '*', credentials: true });\n",
    "origin: '*'",
  );
  assert.ok(cors?.requiresReview && cors.after.includes('ALLOWED_ORIGINS'));

  const acl = runBuilder(
    exposure['storage-object-public-acl'],
    'storage-object-public-acl',
    "s3.putObject({ ACL: 'public-read' });\n",
    "'public-read'",
  );
  assert.ok(acl?.requiresReview && acl.after.includes("'private'"));

  const log = runBuilder(exposure['secret-in-log'], 'secret-in-log', 'console.log(apiSecret);\n', 'apiSecret');
  assert.equal(log?.after, "console.log('[REDACTED]');\n");
  assert.equal(runBuilder(exposure['secret-in-log'], 'secret-in-log', log?.after ?? '', '[REDACTED]'), undefined);

  const xxe = runBuilder(
    exposure['xml-external-entities'],
    'xml-external-entities',
    'parseXml(xml, { noent: true });\n',
    'noent: true',
  );
  assert.equal(xxe?.after, 'parseXml(xml, { noent: false });\n');
  assert.equal(
    runBuilder(exposure['xml-external-entities'], 'xml-external-entities', xxe?.after ?? '', 'noent: false'),
    undefined,
  );

  const cipher = runBuilder(
    authCrypto['insecure-cipher'],
    'insecure-cipher',
    "createCipheriv('rc4', k, iv);\n",
    'createCipheriv',
  );
  assert.ok(cipher?.requiresReview && cipher.after.includes("'aes-256-gcm'"));

  const jwt = runBuilder(
    jwtFixes['jwt-decode-for-auth'],
    'jwt-decode-for-auth',
    'const p = jwt.decode(tok);\n',
    'jwt.decode',
  );
  assert.ok(jwt?.requiresReview && jwt.after.includes('jwt.verify(tok,'));

  const html = runBuilder(
    frontendSecurity['react-dangerously-set-inner-html'],
    'react-dangerously-set-inner-html',
    "import DOMPurify from 'dompurify';\nconst x = <div dangerouslySetInnerHTML={{ __html: raw }} />;\n",
    'dangerouslySetInnerHTML',
    'a.tsx',
  );
  assert.ok(html?.requiresReview && html.after.includes('DOMPurify.sanitize(raw)'));
  assert.equal(
    runBuilder(
      frontendSecurity['react-dangerously-set-inner-html'],
      'react-dangerously-set-inner-html',
      html?.after ?? '',
      'dangerouslySetInnerHTML',
      'a.tsx',
    ),
    undefined,
  );

  const dfRoot = runBuilder(
    fileFixes['dockerfile-runs-as-root'],
    'dockerfile-runs-as-root',
    'FROM node:20\nCMD ["node", "app.js"]\n',
    'FROM',
    'Dockerfile',
  );
  assert.ok(dfRoot?.requiresReview && dfRoot.after.includes('USER nonroot'));

  const dfAdd = runBuilder(
    fileFixes['dockerfile-add-remote-url'],
    'dockerfile-add-remote-url',
    'ADD https://example.com/a.tgz /tmp/a.tgz\n',
    'ADD',
    'Dockerfile',
  );
  assert.ok(dfAdd?.requiresReview && dfAdd.after.includes('RUN curl -fsSL'));
});

test('performance & maintainability new fixers + idempotency + no-op', () => {
  const fetchFix = runBuilder(
    frontendPerf['react-fetch-in-effect-no-abort'],
    'react-fetch-in-effect-no-abort',
    "useEffect(() => {\n  fetch('/api');\n}, []);\n",
    'fetch(',
  );
  assert.ok(fetchFix?.after.includes('new AbortController()') && fetchFix.after.includes('controller.abort()'));
  assert.equal(
    runBuilder(
      frontendPerf['react-fetch-in-effect-no-abort'],
      'react-fetch-in-effect-no-abort',
      fetchFix?.after ?? '',
      'fetch(',
    ),
    undefined,
  );

  const domFix = runBuilder(
    frontendPerf['dom-listener-without-cleanup'],
    'dom-listener-without-cleanup',
    "useEffect(() => {\n  window.addEventListener('resize', onResize);\n}, []);\n",
    'addEventListener',
  );
  assert.ok(domFix?.after.includes("window.removeEventListener('resize', onResize)"));
  assert.equal(
    runBuilder(
      frontendPerf['dom-listener-without-cleanup'],
      'dom-listener-without-cleanup',
      domFix?.after ?? '',
      'addEventListener',
    ),
    undefined,
  );

  const ngFix = runBuilder(
    frontendPerf['angular-subscribe-without-cleanup'],
    'angular-subscribe-without-cleanup',
    "import { takeUntilDestroyed } from '@angular/core/rxjs-interop';\nsrc$.subscribe(() => {});\n",
    'subscribe',
  );
  assert.ok(ngFix?.requiresReview && ngFix.after.includes('.pipe(takeUntilDestroyed()).subscribe'));

  const barrel = runBuilder(
    frontendPerf['frontend-barrel-heavy-import'],
    'frontend-barrel-heavy-import',
    "import { debounce } from 'lodash';\n",
    'lodash',
  );
  assert.equal(barrel?.after, "import debounce from 'lodash/debounce';\n");

  const comp = runBuilder(
    backendPerf['express-missing-compression'],
    'express-missing-compression',
    "import express from 'express';\nconst app = express();\napp.listen(3000);\n",
    'app.listen',
  );
  assert.ok(comp?.requiresReview && comp.after.includes('app.use(compression());'));

  const lean = runBuilder(
    databasePerf['mongoose-hydrate-for-to-object'],
    'mongoose-hydrate-for-to-object',
    'const u = await User.findById(id);\n',
    'findById',
  );
  assert.equal(lean?.after, 'const u = await User.findById(id).lean();\n');
  assert.equal(lean?.requiresReview, true);
  assert.equal(
    runBuilder(
      databasePerf['mongoose-hydrate-for-to-object'],
      'mongoose-hydrate-for-to-object',
      lean?.after ?? '',
      'findById',
    ),
    undefined,
  );

  const exp = runBuilder(
    exportMaint['unused-export'],
    'unused-export',
    'export function helper() { return 1; }\n',
    'helper',
  );
  assert.ok(exp?.requiresReview && exp.after === 'function helper() { return 1; }\n');
});
