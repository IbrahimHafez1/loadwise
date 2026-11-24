import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lint } from './helpers.cjs';
import type { Finding } from '../../lib/shared/types.cjs';

const expressTypes = `
  export interface Request { body: unknown }
  export interface Response { send(body: unknown): void }
  export interface Application {
    use(handler: unknown): void;
    post(path: string, handler: (req: Request, res: Response) => unknown): void;
    listen(port: number): unknown;
  }
  declare function express(): Application;
  export default express;
`;

const files = {
  'node_modules/express/index.d.ts': expressTypes,
  'node_modules/sharp/index.d.ts': `
    interface Sharp { resize(width: number): Sharp; toBuffer(): Promise<Uint8Array> }
    declare function sharp(input: unknown): Sharp;
    export default sharp;
  `,
  'node_modules/puppeteer/index.d.ts': 'export interface Page { pdf(): Promise<Uint8Array> }',
  'node_modules/pdf-lib/index.d.ts': 'export declare class PDFDocument { static create(): Promise<PDFDocument> }',
};

function findings(source: string, ruleId: string, extraFiles = {}) {
  return lint(source, { ...files, ...extraFiles }).filter((finding: Finding) => finding.ruleId === ruleId);
}

const expressServer = "import express from 'express';\nconst app = express();\napp.listen(3000);\n";

test('reports an Express app listening without compression, always as contextual', () => {
  const found = findings(expressServer, 'express-missing-compression');
  assert.equal(found.length, 1);
  assert.match(found[0].contextualReason ?? '', /reverse prox/i);
});

test('stays quiet when the project registers compression middleware', () => {
  const found = findings(expressServer, 'express-missing-compression', {
    'middleware.ts': "import compression from 'compression';\nexport const compress = compression;",
  });
  assert.deepEqual(found, []);
});

test('stays quiet for another listen() in an Express file when express is untyped', () => {
  const found = lint(
    [
      "import express from 'express';",
      "import { Server } from 'socket.io';",
      'const app = express();',
      'const io = new Server();',
      'io.listen(3001);',
      'app.listen(3000);',
    ].join('\n'),
  ).filter((finding: Finding) => finding.ruleId === 'express-missing-compression');
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 6);
});

test('stays quiet for an Express server started by a test file', () => {
  const found = lint('', { ...files, 'app.test.ts': expressServer }).filter(
    (finding: Finding) => finding.ruleId === 'express-missing-compression',
  );
  assert.deepEqual(found, []);
});

test('reports sharp and puppeteer PDF rendering inside a request handler as contextual', () => {
  const found = findings(
    [
      "import express from 'express';",
      "import sharp from 'sharp';",
      "import type { Page } from 'puppeteer';",
      'declare const page: Page;',
      'const app = express();',
      "app.post('/avatar', async (req, res) => { res.send(await sharp(req.body).resize(256).toBuffer()); });",
      "app.post('/invoice', async (req, res) => { res.send(await page.pdf()); });",
    ].join('\n'),
    'heavy-media-in-request-handler',
  );
  assert.equal(found.length, 2);
  assert.ok(found.every((finding: Finding) => finding.contextualReason));
});

test('stays quiet outside handlers, for cheap pdf-lib calls and for a project function named sharp', () => {
  const found = findings(
    [
      "import express from 'express';",
      "import { PDFDocument } from 'pdf-lib';",
      'function sharp(value: unknown) { return value; }',
      'const app = express();',
      "app.post('/doc', async (req, res) => { res.send([await PDFDocument.create(), sharp(req.body)]); });",
      "export async function worker(input: Uint8Array) { return (await import('sharp')).default(input); }",
    ].join('\n'),
    'heavy-media-in-request-handler',
  );
  assert.deepEqual(found, []);
});

test('reports an untyped sharp import inside a request handler', () => {
  const found = lint(
    [
      "import sharp from 'sharp';",
      'export async function upload(req: any, res: any) { res.send(await sharp(req.body).toBuffer()); }',
    ].join('\n'),
  ).filter((finding: Finding) => finding.ruleId === 'heavy-media-in-request-handler');
  assert.equal(found.length, 1);
});
