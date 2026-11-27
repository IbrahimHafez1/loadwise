// Phase 5 security rules: Next.js Server Actions, SSRF redirect bypass, VM sandbox escape,
// weak JWT secret literals, unbounded GraphQL batching, and cookie auth without CSRF.
import { ts } from '../performance/compiler.js';
import { typeFromPackage } from '../performance/package-types.js';
import { reviewedReason, reviewMarkers } from '../performance/review-context.js';
import { libraryCall } from './bindings.js';
import { createFileContext } from './file-context.js';
import { createTaint } from './taint/index.js';
import { hotPathOf } from '../shared/hot-path-graph.js';
import type {
  ArrowFunction,
  CallExpression,
  Expression,
  FunctionDeclaration,
  FunctionExpression,
  NewExpression,
  Node,
  ObjectLiteralExpression,
  SourceFile,
  Statement,
} from 'typescript';
import type {
  Finding,
  LibraryCall,
  ProgramAdapter,
  ReportDetails,
  RulePolicy,
  SecurityRuleContext,
  TaintApi,
} from '../shared/types.js';
import type { SecurityCheck } from './types/security-check.js';

type FunctionNode = FunctionDeclaration | FunctionExpression | ArrowFunction;

interface LocatedFinding extends Finding {
  file: string;
  line: number;
  column: number;
}

const AUTH_CALL_PATTERN =
  /^(?:getSession|getServerSession|auth|currentUser|requireAuth|verifySession|getAuth|requireSession|requireUser|authenticate|authorize|validateSession|verifyAuth|ensureAuth|checkAuth|withAuth)$/i;
const AUTH_HOC_PATTERN = /^(?:withAuth|authAction|authenticatedAction|protectedAction)$/i;
const SSRF_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'request']);
const URL_GUARD_PATTERN =
  /(?:allow|whitelist|validateUrl|isAllowed|isValidUrl|isSafeUrl|assertSafe|checkUrl|allowedHost|ALLOWED_HOST)/i;
const VM_UNSAFE_METHODS = new Set(['runInNewContext', 'runInThisContext', 'runInContext']);
const VM2_CLASSES = new Set(['NodeVM', 'VM']);
const JWT_WEAK_TOKENS = ['secret', 'password', 'changeme', '123456', 'default', 'testkey', 'qwerty'];
const GRAPHQL_FACTORIES = new Set(['createYoga', 'graphqlHTTP']);
const GRAPHQL_LIMIT_PATTERN = /(?:depthLimit|complexity|costAnalysis|queryComplexity|maxBatchSize|batchLimit)/i;
const COOKIE_AUTH_MODULES = new Set([
  'cookie-parser',
  'express-session',
  'cookie-session',
  '@fastify/session',
  '@fastify/cookie',
]);
const COOKIE_AUTH_CALLEES = new Set(['cookieParser', 'cookieSession', 'session']);
const STATE_CHANGING_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const COOKIE_OR_SESSION_PATTERN = /(?:cookie|session)/i;
const CSRF_PATTERN =
  /(?:csurf|csrf-csrf|doubleCsrf|lusca|@fastify\/csrf-protection|fastify-csrf|csrfProtection|csrfSynchronisedProtection|verifyCsrf|validateCsrf|x-csrf-token)/i;

function unwrapExpr(expr: Expression | undefined): Expression | undefined {
  let current = expr;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current))) {
    current = current.expression;
  }
  return current;
}

function getCalleeName(call: CallExpression | NewExpression): string | undefined {
  const callee = unwrapExpr(call.expression);
  if (!callee) return undefined;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function getCalleeObjectName(call: CallExpression | NewExpression): string | undefined {
  const callee = unwrapExpr(call.expression);
  if (!callee || !ts.isPropertyAccessExpression(callee)) return undefined;
  const target = unwrapExpr(callee.expression);
  return target && ts.isIdentifier(target) ? target.text : undefined;
}

function getStringLiteral(expr: Expression | undefined): string | undefined {
  const unwrapped = unwrapExpr(expr);
  if (!unwrapped) return undefined;
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) return unwrapped.text;
  return undefined;
}

function isStaticStringLike(expr: Expression | undefined): boolean {
  const unwrapped = unwrapExpr(expr);
  if (!unwrapped) return false;
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) return true;
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return isStaticStringLike(unwrapped.left) && isStaticStringLike(unwrapped.right);
  }
  return false;
}

function resolveConstString(expr: Expression | undefined, sourceFile: SourceFile, depth = 0): string | undefined {
  const direct = getStringLiteral(expr);
  if (direct !== undefined) return direct;
  const unwrapped = unwrapExpr(expr);
  if (!unwrapped || !ts.isIdentifier(unwrapped) || depth > 3) return undefined;
  let resolved: string | undefined;
  (function findDecl(node: Node): void {
    if (resolved !== undefined) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === unwrapped.text) {
      if (node.parent.flags & ts.NodeFlags.Const && node.initializer) {
        resolved = resolveConstString(node.initializer, sourceFile, depth + 1);
      }
      return;
    }
    ts.forEachChild(node, findDecl);
  })(sourceFile);
  return resolved;
}

function getProperty(obj: ObjectLiteralExpression, name: string): Expression | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const key = ts.isIdentifier(prop.name)
        ? prop.name.text
        : ts.isStringLiteral(prop.name)
          ? prop.name.text
          : undefined;
      if (key === name) return prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === name) {
      return prop.name;
    }
  }
  return undefined;
}

function isBooleanLiteral(expr: Expression | undefined, expected: boolean): boolean {
  const unwrapped = unwrapExpr(expr);
  if (!unwrapped) return false;
  return expected ? unwrapped.kind === ts.SyntaxKind.TrueKeyword : unwrapped.kind === ts.SyntaxKind.FalseKeyword;
}

function hasDirective(statements: readonly Statement[], directive: string): boolean {
  for (const stmt of statements) {
    if (!ts.isExpressionStatement(stmt)) break;
    const text = getStringLiteral(stmt.expression);
    if (text === undefined) break;
    if (text === directive) return true;
  }
  return false;
}

function hasAsyncModifier(node: Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
}

function hasExportModifier(node: Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

function containsAuthCall(root: Node): boolean {
  let found = false;
  (function visit(node: Node): void {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const name = getCalleeName(node);
      if (name && AUTH_CALL_PATTERN.test(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  })(root);
  return found;
}

function isWrappedInAuthHoc(fn: FunctionNode): boolean {
  const parent = fn.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  const name = getCalleeName(parent);
  return Boolean(name && AUTH_HOC_PATTERN.test(name));
}

function checkServerActionNode(fn: FunctionNode, fileUseServer: boolean, context: SecurityRuleContext): void {
  if (!hasAsyncModifier(fn)) return;
  if (isWrappedInAuthHoc(fn)) return;
  const fnUseServer = Boolean(fn.body && ts.isBlock(fn.body) && hasDirective(fn.body.statements, 'use server'));
  if (!fnUseServer && !fileUseServer) return;
  if (!fnUseServer && fileUseServer) {
    const isDirectExport = hasExportModifier(fn);
    const parent = fn.parent;
    const isVarExport =
      parent &&
      ts.isVariableDeclaration(parent) &&
      parent.parent?.parent &&
      ts.isVariableStatement(parent.parent.parent) &&
      hasExportModifier(parent.parent.parent);
    if (!isDirectExport && !isVarExport) return;
  }
  if (fn.body && containsAuthCall(fn.body)) return;
  context.report(
    fn,
    'server-action-missing-auth',
    'Exported Next.js Server Action has no authentication or session verification. Verify the caller session (e.g. `auth()`, `getServerSession()`, or `requireAuth()`) before mutating state.',
  );
}

function checkServerActions(sourceFile: SourceFile, context: SecurityRuleContext): void {
  const fileUseServer = hasDirective(sourceFile.statements, 'use server');
  if (!fileUseServer && !sourceFile.text.includes('use server')) return;
  (function visit(node: Node): void {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      checkServerActionNode(node, fileUseServer, context);
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
}

function hasUrlValidationInScope(node: Node): boolean {
  let current: Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      break;
    }
    current = current.parent;
  }
  const scope = current ?? node.getSourceFile();
  return URL_GUARD_PATTERN.test(scope.getText());
}

function hasRedirectGuard(optionsExpr: Expression | undefined): boolean {
  const unwrapped = unwrapExpr(optionsExpr);
  if (!unwrapped || !ts.isObjectLiteralExpression(unwrapped)) return false;
  const redirectVal = getStringLiteral(getProperty(unwrapped, 'redirect'));
  if (redirectVal === 'manual' || redirectVal === 'error') return true;
  const maxRedirects = unwrapExpr(getProperty(unwrapped, 'maxRedirects'));
  if (maxRedirects && ts.isNumericLiteral(maxRedirects) && Number(maxRedirects.text) === 0) return true;
  const followRedirect = getProperty(unwrapped, 'followRedirect');
  if (isBooleanLiteral(followRedirect, false)) return true;
  return false;
}

function checkSsrfRedirectCall(call: CallExpression, context: SecurityRuleContext): void {
  const calleeName = getCalleeName(call);
  const objName = getCalleeObjectName(call);
  if (!calleeName) return;
  let urlArg: Expression | undefined;
  let optionsArg: Expression | undefined;

  if (calleeName === 'fetch' && !objName) {
    urlArg = call.arguments[0];
    optionsArg = call.arguments[1];
  } else if (
    (calleeName === 'axios' && !objName) ||
    (objName === 'axios' && SSRF_METHODS.has(calleeName)) ||
    (calleeName === 'got' && !objName) ||
    (objName === 'got' && SSRF_METHODS.has(calleeName)) ||
    ((objName === 'http' || objName === 'https') && (calleeName === 'request' || calleeName === 'get'))
  ) {
    const first = unwrapExpr(call.arguments[0]);
    if (first && ts.isObjectLiteralExpression(first)) {
      urlArg = getProperty(first, 'url') ?? getProperty(first, 'href');
      optionsArg = first;
    } else {
      urlArg = call.arguments[0];
      optionsArg = call.arguments[1];
    }
  } else {
    return;
  }

  if (!urlArg || isStaticStringLike(urlArg)) return;
  if (hasRedirectGuard(optionsArg) || hasUrlValidationInScope(call)) return;
  if (!context.taint.trace(urlArg, 'url')) return;
  context.report(
    call,
    'ssrf-redirect-bypass',
    'HTTP request with a dynamic URL does not disable HTTP redirects (`redirect: "manual"` / `"error"` or `maxRedirects: 0`), allowing SSRF allowlist bypasses via 3xx redirects.',
  );
}

function checkVmCall(node: CallExpression | NewExpression, context: SecurityRuleContext): void {
  const calleeName = getCalleeName(node);
  const objName = getCalleeObjectName(node);
  if (!calleeName) return;

  if (ts.isNewExpression(node) && VM2_CLASSES.has(calleeName)) {
    const usesVm2 = context.sourceFile.text.includes('vm2') || calleeName === 'NodeVM';
    if (usesVm2) {
      context.report(
        node,
        'vm-sandbox-escape',
        '`vm2` (`NodeVM`/`VM`) has known critical sandbox escape vulnerabilities. Remove `vm2` and use an OS-level sandbox or `isolated-vm`.',
      );
    }
    return;
  }

  const isVmScript = ts.isNewExpression(node) && calleeName === 'Script' && (objName === 'vm' || !objName);
  const isVmRun = ts.isCallExpression(node) && VM_UNSAFE_METHODS.has(calleeName) && (objName === 'vm' || !objName);
  if (!isVmScript && !isVmRun) return;
  if (objName !== 'vm' && !context.sourceFile.text.includes('vm')) return;

  const codeArg = node.arguments?.[0];
  const contextArg =
    calleeName === 'runInNewContext' || calleeName === 'runInContext' ? node.arguments?.[1] : undefined;
  const dynamicCode = !codeArg || !isStaticStringLike(codeArg);
  const hasContextArg = Boolean(contextArg && unwrapExpr(contextArg));
  if (!dynamicCode && !hasContextArg) return;

  context.report(
    node,
    'vm-sandbox-escape',
    'Node `vm` is not a security sandbox: executing dynamic code or untrusted context objects allows sandbox escape and host RCE.',
  );
}

function isWeakJwtSecret(secret: string): boolean {
  if (secret.startsWith('-----BEGIN ')) return false;
  if (secret.length < 32) return true;
  const lower = secret.toLowerCase();
  if (JWT_WEAK_TOKENS.some((tok) => lower.includes(tok))) return true;
  return new Set(secret).size < 6;
}

function extractEncodedSecret(expr: Expression | undefined, sourceFile: SourceFile): string | undefined {
  const unwrapped = unwrapExpr(expr);
  if (!unwrapped) return undefined;
  if (ts.isCallExpression(unwrapped) && getCalleeName(unwrapped) === 'encode' && unwrapped.arguments.length > 0) {
    return resolveConstString(unwrapped.arguments[0], sourceFile);
  }
  return resolveConstString(unwrapped, sourceFile);
}

function checkJwtWeakSecret(call: CallExpression, context: SecurityRuleContext): void {
  const calleeName = getCalleeName(call);
  const objName = getCalleeObjectName(call);
  if (!calleeName) return;

  let secretExpr: Expression | undefined;
  if (calleeName === 'jwtVerify' || (calleeName === 'sign' && call.arguments.length === 1)) {
    secretExpr = call.arguments[1] ?? call.arguments[0];
  } else if ((calleeName === 'sign' || calleeName === 'verify') && (objName === 'jwt' || !objName)) {
    const second = unwrapExpr(call.arguments[1]);
    if (second && ts.isObjectLiteralExpression(second)) {
      secretExpr = getProperty(second, 'secret');
    } else {
      secretExpr = call.arguments[1];
    }
  } else if (objName === 'JwtModule' && (calleeName === 'register' || calleeName === 'forRoot')) {
    const opts = unwrapExpr(call.arguments[0]);
    if (opts && ts.isObjectLiteralExpression(opts)) secretExpr = getProperty(opts, 'secret');
  } else if (
    (calleeName === 'sign' || calleeName === 'signAsync' || calleeName === 'verify' || calleeName === 'verifyAsync') &&
    objName?.toLowerCase().includes('jwt')
  ) {
    const second = unwrapExpr(call.arguments[1]);
    if (second && ts.isObjectLiteralExpression(second)) {
      secretExpr = getProperty(second, 'secret');
    } else {
      secretExpr = call.arguments[1];
    }
  } else {
    return;
  }

  const literal = extractEncodedSecret(secretExpr, context.sourceFile);
  if (literal === undefined || !isWeakJwtSecret(literal)) return;
  context.report(
    secretExpr ?? call,
    'jwt-weak-secret-literal',
    'JWT signing/verification uses a short (< 32 chars) or weak literal secret, making tokens vulnerable to offline brute-force forgery. Load a >= 256-bit random secret from environment/KMS.',
  );
}

function hasBatchOrCostLimit(options: ObjectLiteralExpression): boolean {
  const batching = unwrapExpr(getProperty(options, 'batching'));
  if (batching && ts.isObjectLiteralExpression(batching) && getProperty(batching, 'limit')) {
    return true;
  }
  if (getProperty(options, 'maxBatchSize') || getProperty(options, 'batchLimit')) return true;
  const validationRules = getProperty(options, 'validationRules');
  if (validationRules && GRAPHQL_LIMIT_PATTERN.test(validationRules.getText())) return true;
  const plugins = getProperty(options, 'plugins');
  if (plugins && GRAPHQL_LIMIT_PATTERN.test(plugins.getText())) return true;
  return false;
}

function checkGraphqlBatching(node: CallExpression | NewExpression, context: SecurityRuleContext): void {
  const calleeName = getCalleeName(node);
  const objName = getCalleeObjectName(node);
  const isServer =
    (ts.isNewExpression(node) && calleeName === 'ApolloServer') ||
    (ts.isCallExpression(node) && GRAPHQL_FACTORIES.has(calleeName ?? '')) ||
    (ts.isCallExpression(node) &&
      objName === 'GraphQLModule' &&
      (calleeName === 'forRoot' || calleeName === 'forRootAsync'));
  if (!isServer) return;

  const firstArg = unwrapExpr(node.arguments?.[0]);
  if (!firstArg || !ts.isObjectLiteralExpression(firstArg)) return;

  const allowBatch = getProperty(firstArg, 'allowBatchedHttpRequests');
  const batching = getProperty(firstArg, 'batching');
  const batchEnabled = isBooleanLiteral(allowBatch, true) || isBooleanLiteral(batching, true);
  if (!batchEnabled || hasBatchOrCostLimit(firstArg)) return;

  context.report(
    node,
    'graphql-batching-unbounded',
    'GraphQL batching is enabled without a batch size, query depth, or cost/complexity limit, allowing batching DoS and brute-force attacks.',
  );
}

function checkExpressCookieAuthCsrf(sourceFile: SourceFile, context: SecurityRuleContext): void {
  const text = sourceFile.text;
  if (!COOKIE_OR_SESSION_PATTERN.test(text) || CSRF_PATTERN.test(text)) return;

  let cookieAuthNode: Node | undefined;
  let hasStateChangingRoute = false;
  let hasStrictSameSite = false;

  (function visit(node: Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (COOKIE_AUTH_MODULES.has(node.moduleSpecifier.text) && !cookieAuthNode) {
        cookieAuthNode = node;
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isIdentifier(node.name)
        ? node.name.text
        : ts.isStringLiteral(node.name)
          ? node.name.text
          : undefined;
      if (key === 'sameSite') {
        const val = getStringLiteral(node.initializer);
        if (val && val.toLowerCase() === 'strict') hasStrictSameSite = true;
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = getCalleeName(node);
      const obj = getCalleeObjectName(node);
      if (callee && COOKIE_AUTH_CALLEES.has(callee)) cookieAuthNode = node;
      if ((obj === 'res' || obj === 'reply') && (callee === 'cookie' || callee === 'setCookie')) {
        cookieAuthNode = cookieAuthNode ?? node;
      }
      if (callee && STATE_CHANGING_METHODS.has(callee) && obj) {
        hasStateChangingRoute = true;
      }
    }
    ts.forEachChild(node, visit);
  })(sourceFile);

  if (!cookieAuthNode || !hasStateChangingRoute || hasStrictSameSite) return;
  context.report(
    cookieAuthNode,
    'express-cookie-auth-missing-csrf',
    'Cookie-based auth/session is used with state-changing routes without CSRF protection (`csurf`, `csrf-csrf`, `lusca`, `@fastify/csrf-protection`) or `sameSite: "strict"`.',
  );
}

export const checks: Readonly<Record<string, readonly SecurityCheck[]>> = {
  SourceFile: [
    (node, context) => {
      if (!ts.isSourceFile(node)) return;
      checkServerActions(node, context);
      checkExpressCookieAuthCsrf(node, context);
    },
  ],
  CallExpression: [
    (node, context) => {
      if (!ts.isCallExpression(node)) return;
      checkSsrfRedirectCall(node, context);
      checkVmCall(node, context);
      checkJwtWeakSecret(node, context);
      checkGraphqlBatching(node, context);
    },
  ],
  NewExpression: [
    (node, context) => {
      if (!ts.isNewExpression(node)) return;
      checkVmCall(node, context);
      checkGraphqlBatching(node, context);
    },
  ],
};

export function collectPhase5SecurityFindings(
  program: ProgramAdapter,
  sourceFile: SourceFile,
  policy?: RulePolicy,
): LocatedFinding[] {
  const checker = program.getTypeChecker();
  const findings: LocatedFinding[] = [];
  const reported = new Set<string>();
  const hasReviewComments = reviewMarkers.some((marker) => sourceFile.text.includes(marker));
  const fileContext = createFileContext(sourceFile);
  let taint: TaintApi | undefined;
  const libraryCalls = new WeakMap<CallExpression | NewExpression, LibraryCall | undefined>();

  const context: SecurityRuleContext = {
    program,
    checker,
    sourceFile,
    policy,
    fileContext,
    strictNullChecks: policy
      ? Boolean(program.getCompilerOptions().strictNullChecks ?? program.getCompilerOptions().strict)
      : false,
    isPackageType: (node: Node, packages: readonly string[], typeNames?: readonly string[]) =>
      typeFromPackage(checker.getTypeAtLocation(node), packages, typeNames),
    libraryCall(call: CallExpression | NewExpression) {
      if (!libraryCalls.has(call)) libraryCalls.set(call, libraryCall(call, context));
      return libraryCalls.get(call);
    },
    get taint() {
      return (taint ??= createTaint(program));
    },
    report(node: Node, ruleId: string, message: string, contextualReason?: string, details?: ReportDetails) {
      const start = node.getStart(sourceFile);
      const key = `${start}:${ruleId}`;
      if (reported.has(key)) return;
      reported.add(key);
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
      const reason =
        (hasReviewComments && reviewedReason(sourceFile, line, ruleId)) ||
        contextualReason ||
        fileContext.testSourceReason;
      const finding: LocatedFinding = {
        file: sourceFile.fileName,
        line: line + 1,
        column: character + 1,
        ruleId,
        message,
      };
      if (reason) finding.contextualReason = reason;
      const { taint: traced, ...rest }: ReportDetails = details ?? {};
      Object.assign(finding, rest);
      if (traced) finding.trace = traced.steps;
      finding.hotPath = hotPathOf(node, program);
      findings.push(finding);
    },
  };

  (function visit(node: Node): void {
    const kindName = ts.SyntaxKind[node.kind];
    const kindChecks = kindName ? checks[kindName] : undefined;
    if (kindChecks) for (const check of kindChecks) check(node, context);
    ts.forEachChild(node, visit);
  })(sourceFile);

  return findings.sort(
    (left, right) => left.line - right.line || left.column - right.column || left.ruleId.localeCompare(right.ruleId),
  );
}
