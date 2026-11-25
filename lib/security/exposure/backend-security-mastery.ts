// express-missing-helmet: Express or NestJS (express platform) server app without security header
// middleware. A hardcoded JWT fallback secret (`process.env.X || 'literal'`) is covered by
// hardcoded-secret in auth-crypto/secrets.cjs.
import { ts } from '../../performance/compiler.js';
import { declaredInPackage } from '../../performance/schema/ts-helpers.js';
import type { CallExpression, Expression, Identifier, SourceFile } from 'typescript';
import type { CheckerAdapter, ProgramAdapter, SecurityRuleContext } from '../../shared/types.js';

const RULE_ID = 'express-missing-helmet';
const EXPRESS_PACKAGES = ['express', '@types/express', '@types/express-serve-static-core'];
const NEST_PACKAGES = ['@nestjs/common', '@nestjs/core'];
const HEADER_MIDDLEWARE_PATTERN = /['"](?:helmet|@fastify\/helmet|fastify-helmet|koa-helmet|lusca)(?:\/[^'"]*)?['"]/;
// Headers set by hand count as handled; the usual pair that helmet exists to provide.
const MANUAL_HEADER_PATTERN = /x-content-type-options|strict-transport-security/i;
// Test files start throwaway servers with `app.listen(0)`.
const TEST_FILE =
  /(?:\/(?:__tests__|__fixtures__|__mocks__|e2e|playwright|cypress)\/|\.(?:test|spec|e2e|e2e-spec|itest|e2e-test)\.[cm]?[jt]sx?$)/;
const CONTEXTUAL_REASON =
  'Reverse proxies and CDNs (Nginx, Cloudflare, ALB) often set security headers outside Node; dismiss if headers are handled at the edge.';
const MESSAGE =
  'This server app starts without `helmet` security headers middleware. Add `app.use(helmet())` to set `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options` and other defaults (or set them at your reverse proxy).';

const headerHandlingByProgram = new WeakMap<ProgramAdapter, boolean>();

function isProjectSource(file: SourceFile) {
  return !file.isDeclarationFile && !/[\\/]node_modules[\\/]/.test(file.fileName);
}

function programHandlesSecurityHeaders(program: ProgramAdapter) {
  const listSources = program?.getToolingSourceFiles ?? program?.getSourceFiles;
  if (!listSources) return false;
  if (!headerHandlingByProgram.has(program)) {
    const handled = listSources
      .call(program)
      .some(
        (file) =>
          isProjectSource(file) && (HEADER_MIDDLEWARE_PATTERN.test(file.text) || MANUAL_HEADER_PATTERN.test(file.text)),
      );
    headerHandlingByProgram.set(program, handled);
  }
  return headerHandlingByProgram.get(program);
}

function importsModule(sourceFile: SourceFile, moduleName: string) {
  return new RegExp(`['"]${moduleName}(?:/[^'"]*)?['"]`).test(sourceFile.text);
}

function initializerCall(identifier: Identifier, checker: CheckerAdapter) {
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return;
  let value = ts.skipOuterExpressions(declaration.initializer);
  while (ts.isAwaitExpression(value)) value = ts.skipOuterExpressions(value.expression);
  return ts.isCallExpression(value) ? value : undefined;
}

// `const app = express()` when express has no types: the receiver itself must be the app, so
// `io.listen()` or a second server in the same file is not mistaken for it.
function initializedByExpressCall(receiver: Expression, checker: CheckerAdapter) {
  const call = ts.isIdentifier(receiver) ? initializerCall(receiver, checker) : undefined;
  return !!call && ts.isIdentifier(call.expression) && call.expression.text === 'express';
}

// `const app = await NestFactory.create(AppModule)` without installed Nest types.
function initializedByNestFactory(receiver: Expression, checker: CheckerAdapter) {
  const call = ts.isIdentifier(receiver) ? initializerCall(receiver, checker) : undefined;
  const callee = call && ts.isPropertyAccessExpression(call.expression) ? call.expression : undefined;
  return !!callee && ts.isIdentifier(callee.expression) && callee.expression.text === 'NestFactory';
}

function isFastifyApp(sourceFile: SourceFile) {
  return importsModule(sourceFile, '@nestjs/platform-fastify');
}

function isServerListen(call: CallExpression, context: SecurityRuleContext) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'listen') return false;
  const sourceFile = call.getSourceFile();
  if (TEST_FILE.test(sourceFile.fileName.replaceAll('\\', '/'))) return false;
  const receiver = ts.skipOuterExpressions(callee.expression);
  if (importsModule(sourceFile, 'express')) {
    return (
      declaredInPackage(callee, context.checker, EXPRESS_PACKAGES) ||
      initializedByExpressCall(receiver, context.checker)
    );
  }
  if (!importsModule(sourceFile, '@nestjs/core') || isFastifyApp(sourceFile)) return false;
  return (
    declaredInPackage(callee, context.checker, NEST_PACKAGES) || initializedByNestFactory(receiver, context.checker)
  );
}

function checkCall(call: CallExpression, context: SecurityRuleContext) {
  if (!isServerListen(call, context) || context.fileContext.isTestSource) return;
  if (programHandlesSecurityHeaders(context.program)) return;
  context.report(call, RULE_ID, MESSAGE, CONTEXTUAL_REASON);
}

export { checkCall };
