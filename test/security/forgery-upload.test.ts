import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintWithoutTypes } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';

const ruleId = 'upload-client-filename';

function findings(filename: string, imports = "import multer, { diskStorage } from 'multer';") {
  const source = [imports, `const storage = diskStorage({ destination: '/uploads', filename: ${filename} });`].join(
    '\n',
  );
  return lintWithoutTypes(source).filter((finding: Finding) => finding.ruleId === ruleId);
}

test('disk storage that keeps the client file name is reported', () => {
  const [direct] = findings('(req: any, file: any, cb: any) => cb(null, file.originalname)');
  assert.match(direct.message, /file name the client sent/);
  assert.equal(
    findings('(req: any, file: any, done: any) => { const name = file.originalname.toLowerCase(); done(null, name); }')
      .length,
    1,
  );
  assert.equal(findings('function (req: any, file: any, cb: any) { cb(null, `${file.originalname}`); }').length, 1);
  const namespace = "const multer = require('multer');\nconst diskStorage = multer.diskStorage;";
  assert.equal(
    lintWithoutTypes(
      `${namespace}\nmulter.diskStorage({ filename: (req: any, file: any, cb: any) => cb(null, file.originalname) });`,
    ).filter((finding: Finding) => finding.ruleId === ruleId).length,
    1,
  );
});

test('generated names, prefixed names and other libraries are not reported', () => {
  assert.equal(findings('(req: any, file: any, cb: any) => cb(null, Date.now() + "-" + file.originalname)').length, 0);
  assert.equal(
    findings(
      '(req: any, file: any, cb: any) => cb(null, crypto.randomUUID())',
      "import { diskStorage } from 'multer';\ndeclare const crypto: any;",
    ).length,
    0,
  );
  assert.equal(
    findings(
      '(req: any, file: any, cb: any) => cb(null, `${Date.now()}${extname(file.originalname)}`)',
      "import { diskStorage } from 'multer';\ndeclare function extname(p: string): string;",
    ).length,
    0,
  );
  assert.equal(
    findings(
      '(req: any, file: any, cb: any) => cb(null, file.originalname)',
      'declare function diskStorage(options: unknown): unknown;',
    ).length,
    0,
  );
  assert.equal(findings('(req: any, file: any, cb: any) => cb(new Error(file.originalname))').length, 0);
});
