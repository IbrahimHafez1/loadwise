import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProgram } from '../performance/helpers.js';
import { createAnalyzer } from '../../lib/security/analyze.js';
import { checkCall } from '../../lib/security/exposure/backend-security-mastery.js';
import type { SourceFile } from 'typescript';
import type { ProgramAdapter } from '../../lib/shared/types.js';
import { reasonOf } from '../types/finding-reason.js';

const analyzeFile = createAnalyzer([{ checks: { CallExpression: [checkCall] } }]);
const ruleId = 'express-missing-helmet';

const expressTypes = [
  'export interface Application { use(handler: unknown): void; listen(port: number): unknown }',
  'declare function express(): Application;',
  'export default express;',
].join('\n');
const nestTypes = [
  'export declare class NestFactory {',
  '  static create(module: unknown): Promise<{ use(handler: unknown): void; listen(port: number): Promise<void> }>;',
  '}',
].join('\n');
const files = {
  'node_modules/express/index.d.ts': expressTypes,
  'node_modules/@nestjs/core/index.d.ts': nestTypes,
  'node_modules/helmet/index.d.ts': 'declare function helmet(): unknown; export default helmet;',
};

function findings(source: string, extraFiles = {}, typed = true) {
  const projectFiles = typed ? { ...files, ...extraFiles } : extraFiles;
  return withProgram(source, projectFiles, (program: ProgramAdapter, sourceFile: SourceFile) =>
    analyzeFile(program, sourceFile).filter((finding) => finding.ruleId === ruleId),
  );
}

const expressServer = "import express from 'express';\nconst app = express();\napp.listen(3000);\n";
const nestServer =
  "import { NestFactory } from '@nestjs/core';\nasync function main() {\n  const app = await NestFactory.create({});\n  await app.listen(3000);\n}\nmain();\n";

test('an Express app listening without helmet is reported, always as contextual', () => {
  for (const typed of [true, false]) {
    const found = findings(expressServer, {}, typed);
    assert.equal(found.length, 1, `typed=${typed}`);
    assert.match(reasonOf(found[0]), /reverse prox/i);
  }
});

test('a NestJS app listening without helmet is reported', () => {
  for (const typed of [true, false]) assert.equal(findings(nestServer, {}, typed).length, 1, `typed=${typed}`);
});

test('helmet, other header middleware or hand-set headers anywhere in the project silence the rule', () => {
  const handlers = [
    "import helmet from 'helmet';\nexport const secure = helmet();",
    "import helmet from '@fastify/helmet';\nexport const secure = helmet;",
    "export const headers = (res: { setHeader(name: string, value: string): void }) => res.setHeader('X-Content-Type-Options', 'nosniff');",
  ];
  for (const handler of handlers) {
    assert.deepEqual(findings(expressServer, { 'security.ts': handler }), [], handler);
    assert.deepEqual(findings(nestServer, { 'security.ts': handler }), [], handler);
  }
});

test('other listen() calls and servers that are not Express or Nest are clean', () => {
  const socketFile = [
    "import express from 'express';",
    "import { Server } from 'socket.io';",
    'const app = express();',
    'app.use(1);',
    'const io = new Server();',
    'io.listen(3001);',
  ].join('\n');
  assert.deepEqual(findings(socketFile, {}, false), []);
  assert.deepEqual(findings('import http from "node:http";\nhttp.createServer().listen(3000);'), []);
  assert.deepEqual(findings('declare const app: { listen(port: number): void };\napp.listen(3000);'), []);
  const fastify =
    "import { NestFactory } from '@nestjs/core';\nimport { FastifyAdapter } from '@nestjs/platform-fastify';\nconst app = await NestFactory.create({}, new FastifyAdapter());\nawait app.listen(3000);\n";
  assert.deepEqual(findings(fastify, {}, false), []);
});
