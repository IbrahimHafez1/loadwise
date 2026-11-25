import { spawnSync } from 'node:child_process';
import { drizzle, typeorm, sequelize, mongoose } from './fixtures/schema/orm-stubs.js';
import { lint } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';
import type { OrmName } from '../types/orm-name.js';
import type { FileMap } from '../types/project-files.js';
import { join } from 'node:path';
import * as nativeRuntime from '../../lib/performance/native-runtime.js';

// Fixture projects live on disk (package.json, schema.prisma, migrations); their sources are
// in-memory overlays.
const projects: Record<OrmName, string> = {
  prisma: '../fixtures/schema/prisma-shop/',
  drizzle: '../fixtures/schema/drizzle-app/',
  typeorm: '../fixtures/schema/typeorm-app/',
  sequelize: '../fixtures/schema/sequelize-app/',
  mongoose: '../fixtures/schema/mongoose-app/',
};

const prismaMethods = ['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'count', 'updateMany', 'deleteMany'];

function prismaDelegate(model: string) {
  return `export interface ${model}Delegate {\n${prismaMethods
    .map(
      (method) =>
        `  ${method}(args?: { where?: object; orderBy?: object; take?: number; select?: object }): Promise<any>;`,
    )
    .join('\n')}\n}`;
}

const prismaClient = `${['User', 'Store', 'Product', 'Order', 'OrderSummary'].map(prismaDelegate).join('\n')}
export declare class PrismaClient {
  user: UserDelegate; store: StoreDelegate; product: ProductDelegate; order: OrderDelegate; orderSummary: OrderSummaryDelegate;
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}`;

function withPrefix(prefix: string, files: FileMap): FileMap {
  return Object.fromEntries(Object.entries(files).map(([name, contents]) => [prefix + name, contents]));
}

function projectFiles(orm: OrmName, files: FileMap): FileMap {
  const stubs: Record<OrmName, FileMap> = {
    prisma: { 'node_modules/.prisma/client/index.d.ts': prismaClient },
    drizzle,
    typeorm,
    sequelize,
    mongoose,
  };
  return withPrefix(projects[orm], { ...stubs[orm], ...files });
}

// [line, ruleId, message, contextualReason?] for index rules only.
function indexFindings(source: string, files: FileMap) {
  return lint(source, files)
    .filter((finding: Finding) => finding.ruleId.startsWith('index-'))
    .map((finding: Finding) => ({
      line: finding.line,
      ruleId: finding.ruleId,
      message: finding.message,
      ...(finding.contextualReason ? { contextualReason: finding.contextualReason } : {}),
      ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
      ...(finding.related ? { related: finding.related } : {}),
    }));
}

function nativeAvailable() {
  try {
    nativeRuntime.executable();
    return true;
  } catch {
    return false;
  }
}

// Re-runs a test file on the TypeScript 7 engine; the same assertions then prove identical
// findings.
function runOnNativeEngine(testFile: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, PERF_CHECK_TEST_NATIVE: '1' };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', testFile], {
    cwd: join(import.meta.dirname, '..', '..'),
    encoding: 'utf8',
    env,
  });
}

export { projects, projectFiles, indexFindings, nativeAvailable, runOnNativeEngine };
