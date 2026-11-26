// express-missing-compression: Express server app without compression middleware registered in the
// project. heavy-media-in-request-handler: CPU-heavy image (sharp) or PDF rendering inside an HTTP
// request handler.
import { ts } from './compiler.js';
import { declaredInPackage } from './schema/ts-helpers.js';
import { enclosingRequestHandler } from './request-handlers.js';
import type { CallExpression, Expression, Identifier, PropertyAccessExpression, SourceFile } from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext, ProgramAdapter } from '../shared/types.js';

const COMPRESSION_RULE = 'express-missing-compression';
const HEAVY_MEDIA_RULE = 'heavy-media-in-request-handler';
const COMPRESSION_PATTERN = /['"](?:compression|shrink-ray-current|@fastify\/compress)['"]/;
const EXPRESS_PACKAGES = ['express', '@types/express', '@types/express-serve-static-core'];
const SHARP_PACKAGES = ['sharp'];
// Only calls that do the rendering: pdf-lib's PDFDocument.create() builds an empty document
// cheaply.
const PDF_RENDERERS = [
  { packages: ['puppeteer', 'puppeteer-core'], methods: new Set(['pdf']), kind: 'headless browser PDF rendering' },
  { packages: ['html-pdf'], methods: new Set(['create']), kind: 'html-pdf rendering' },
];
// Test files start throwaway servers with `app.listen(0)`.
const TEST_FILE =
  /(?:\/(?:__tests__|__fixtures__|__mocks__|e2e|playwright|cypress)\/|\.(?:test|spec|e2e|e2e-spec|itest|e2e-test)\.[cm]?[jt]sx?$)/;
const COMPRESSION_REASON =
  'Reverse proxies (Nginx, Cloudflare, ALB) often compress responses outside Node; dismiss if compression is handled at the edge.';
const HEAVY_MEDIA_REASON =
  'Offloading changes the API: a client that needs the rendered file in the same response, or a low-traffic internal endpoint, may keep the work in the handler.';

const compressionByProgram = new WeakMap<ProgramAdapter, boolean>();

function programUsesCompression(program: ProgramAdapter): boolean {
  const files = program?.getSourceFiles?.() ?? program?.getToolingSourceFiles?.();
  if (!files) return false;
  if (!compressionByProgram.has(program)) {
    compressionByProgram.set(
      program,
      files.some(
        (file) =>
          !file.isDeclarationFile &&
          !/[\\/]node_modules[\\/]/.test(file.fileName) &&
          COMPRESSION_PATTERN.test(file.text),
      ),
    );
  }
  return compressionByProgram.get(program) === true;
}

const moduleImportPatterns = new Map<string, RegExp>();
const moduleImportCache = new WeakMap<SourceFile, Map<string, boolean>>();

function importsModule(sourceFile: SourceFile, moduleName: string): boolean {
  let byModule = moduleImportCache.get(sourceFile);
  if (byModule) {
    const cached = byModule.get(moduleName);
    if (cached !== undefined) return cached;
  } else {
    byModule = new Map();
    moduleImportCache.set(sourceFile, byModule);
  }
  let pattern = moduleImportPatterns.get(moduleName);
  if (!pattern) {
    pattern = new RegExp(`['"]${moduleName}(?:/[^'"]*)?['"]`);
    moduleImportPatterns.set(moduleName, pattern);
  }
  const imported = pattern.test(sourceFile.text);
  byModule.set(moduleName, imported);
  return imported;
}

// `const app = express()` when express has no types: the receiver itself must be the app, so
// `io.listen()` or a second server in the same file is not mistaken for it.
function initializedByExpressCall(receiver: Expression, checker: CheckerAdapter) {
  if (!ts.isIdentifier(receiver)) return false;
  const declaration = checker.getSymbolAtLocation(receiver)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
  const value = ts.skipOuterExpressions(declaration.initializer);
  return ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'express';
}

function isExpressAppListen(call: CallExpression, context: PerformanceRuleContext): boolean {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'listen') return false;
  const sourceFile = call.getSourceFile();
  if (!importsModule(sourceFile, 'express') || TEST_FILE.test(sourceFile.fileName.replaceAll('\\', '/'))) return false;
  return (
    declaredInPackage(callee, context.checker, EXPRESS_PACKAGES) ||
    initializedByExpressCall(ts.skipOuterExpressions(callee.expression), context.checker)
  );
}

// `import sharp from 'sharp'` or `const sharp = require('sharp')` when sharp has no types; a
// project function that happens to be named sharp is not the library.
function boundToSharpModule(identifier: Identifier, checker: CheckerAdapter): boolean {
  const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  if (!declaration) return false;
  const importDeclaration = ts.findAncestor(declaration, ts.isImportDeclaration);
  if (importDeclaration) {
    return ts.isStringLiteral(importDeclaration.moduleSpecifier) && importDeclaration.moduleSpecifier.text === 'sharp';
  }
  const value = ts.isVariableDeclaration(declaration) && declaration.initializer;
  const call = value && ts.skipOuterExpressions(value);
  if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return false;
  const [specifier] = call.arguments;
  return (
    call.expression.text === 'require' && !!specifier && ts.isStringLiteral(specifier) && specifier.text === 'sharp'
  );
}

function isSharpCall(callee: Expression, context: PerformanceRuleContext): boolean {
  if (!ts.isIdentifier(callee) || callee.text !== 'sharp') return false;
  return declaredInPackage(callee, context.checker, SHARP_PACKAGES) || boundToSharpModule(callee, context.checker);
}

function pdfRenderKind(callee: Expression, context: PerformanceRuleContext): string | undefined {
  if (!ts.isPropertyAccessExpression(callee)) return;
  const sourceFile = callee.getSourceFile();
  const renderer = PDF_RENDERERS.find(
    (candidate) =>
      candidate.methods.has(callee.name.text) &&
      candidate.packages.some((name) => importsModule(sourceFile, name)) &&
      declaredInPackageOrUntyped(callee, context.checker, candidate.packages),
  );
  return renderer?.kind;
}

// Without the package's types the method has no declaration; the import above is then the only
// evidence.
function declaredInPackageOrUntyped(
  callee: PropertyAccessExpression,
  checker: CheckerAdapter,
  packages: readonly string[],
): boolean {
  const declarations = checker.getSymbolAtLocation(callee.name)?.declarations;
  return !declarations?.length || declaredInPackage(callee, checker, packages);
}

function heavyMediaKind(call: CallExpression, context: PerformanceRuleContext): string | undefined {
  const callee = ts.skipOuterExpressions(call.expression);
  if (isSharpCall(callee, context)) return 'sharp image processing';
  return pdfRenderKind(callee, context);
}

function check(call: CallExpression, context: PerformanceRuleContext): void {
  if (isExpressAppListen(call, context)) {
    if (programUsesCompression(context.program)) return;
    context.report(
      call,
      COMPRESSION_RULE,
      'This Express server has no response compression middleware (`compression`). Enable `app.use(compression())` (or handle gzip/brotli at your reverse proxy) to reduce JSON and HTML payload sizes.',
      COMPRESSION_REASON,
    );
    return;
  }
  if (!enclosingRequestHandler(call)) return;
  const mediaKind = heavyMediaKind(call, context);
  if (!mediaKind) return;
  context.report(
    call,
    HEAVY_MEDIA_RULE,
    `Running ${mediaKind} directly inside an HTTP request handler consumes CPU/memory on the request path and risks request timeouts under load. Offload it to a background job queue (e.g. BullMQ) or a dedicated worker thread.`,
    HEAVY_MEDIA_REASON,
  );
}

export { check };
