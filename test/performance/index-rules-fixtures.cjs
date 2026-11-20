'use strict';

const { spawnSync } = require('node:child_process');
const { drizzle, typeorm, sequelize, mongoose } = require('./fixtures/schema/orm-stubs.cjs');
const { lint } = require('./helpers.cjs');

// Fixture projects live on disk (package.json, schema.prisma, migrations); their sources are in-memory overlays.
const projects = {
  prisma: '../fixtures/schema/prisma-shop/',
  drizzle: '../fixtures/schema/drizzle-app/',
  typeorm: '../fixtures/schema/typeorm-app/',
  sequelize: '../fixtures/schema/sequelize-app/',
  mongoose: '../fixtures/schema/mongoose-app/',
};

const prismaMethods = ['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'count', 'updateMany', 'deleteMany'];

function prismaDelegate(model) {
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

function withPrefix(prefix, files) {
  return Object.fromEntries(Object.entries(files).map(([name, contents]) => [prefix + name, contents]));
}

function projectFiles(orm, files) {
  const stubs = {
    prisma: { 'node_modules/.prisma/client/index.d.ts': prismaClient },
    drizzle,
    typeorm,
    sequelize,
    mongoose,
  }[orm];
  return withPrefix(projects[orm], { ...stubs, ...files });
}

// [line, ruleId, message, contextualReason?] for index rules only.
function indexFindings(source, files) {
  return lint(source, files)
    .filter((finding) => finding.ruleId.startsWith('index-'))
    .map((finding) => ({
      line: finding.line,
      ruleId: finding.ruleId,
      message: finding.message,
      ...(finding.contextualReason && { contextualReason: finding.contextualReason }),
      ...(finding.suggestion && { suggestion: finding.suggestion }),
      ...(finding.related && { related: finding.related }),
    }));
}

function nativeAvailable() {
  try {
    require('../../lib/performance/native-runtime.cjs').executable();
    return true;
  } catch {
    return false;
  }
}

// Re-runs a test file on the TypeScript 7 engine; the same assertions then prove identical findings.
function runOnNativeEngine(testFile) {
  const env = { ...process.env, PERF_CHECK_TEST_NATIVE: '1' };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', testFile], {
    cwd: require('node:path').join(__dirname, '..', '..'),
    encoding: 'utf8',
    env,
  });
}

module.exports = { projects, projectFiles, indexFindings, nativeAvailable, runOnNativeEngine };
