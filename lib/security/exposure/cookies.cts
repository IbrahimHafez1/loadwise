// cookie-missing-security-flags: a session, token or auth cookie set without httpOnly, secure or
// sameSite.
import { loadSyntax } from '../../performance/compiler.cjs';
import { importedFrom } from '../bindings.cjs';
import {
  unwrap,
  objectLiteralOf,
  findProperty,
  isFullyLiteral,
  isFalse,
  chainRootName,
  methodName,
} from './literals.cjs';
import type { CallExpression, Expression, Node, ObjectLiteralExpression } from 'typescript';
import type { SecurityRuleContext } from '../../shared/types.cjs';
const ts = loadSyntax();

const ruleId = 'cookie-missing-security-flags';
const sensitiveNamePattern = /sess|sid|token|auth|jwt|refresh|access/i;
// Anti-forgery cookies are read by scripts on purpose.
const scriptReadableNamePattern = /csrf|xsrf/i;
const responseNames = new Set(['res', 'response', 'reply']);
const sessionModules = new Set(['express-session', 'cookie-session', '@fastify/session', '@fastify/secure-session']);
// cookie-session reads its flags from the options themselves; the other session libraries from
// `cookie`.
const flagsAtTopLevel = new Set(['cookie-session']);
const deploymentReason = 'Only secure or sameSite is missing; confirm how the deployment sets them.';

interface CookieDefaults {
  httpOnlyDefault: boolean;
}

interface CookieFlagContext extends CookieDefaults {
  scriptReadable: boolean;
}

interface CookieAssessment {
  missing: string[];
  definite: boolean;
}

function nameOf(expression: Expression) {
  const node = unwrap(expression);
  if (!node) return '';
  if (ts.isStringLiteralLike(node) || ts.isIdentifier(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return '';
}

function isSensitiveCookie(nameArgument: Expression, valueArgument: Expression) {
  const name = nameOf(nameArgument);
  return sensitiveNamePattern.test(name) || sensitiveNamePattern.test(nameOf(valueArgument));
}

// What a cookie options literal leaves out. `httpOnlyDefault` is true where the library already
// sets it.
function assess(
  options: ObjectLiteralExpression | undefined,
  { httpOnlyDefault, scriptReadable }: CookieFlagContext,
): CookieAssessment {
  const missing: string[] = [];
  let definite = false;
  const httpOnly = options && findProperty(options, 'httpOnly');
  if (!scriptReadable && (isFalse(httpOnly?.value) || (!httpOnly && !httpOnlyDefault))) {
    missing.push('httpOnly');
    definite = true;
  }
  const secure = options && findProperty(options, 'secure');
  if (!secure || isFalse(secure.value)) missing.push('secure');
  if (isFalse(secure?.value)) definite = true;
  if (!options || !findProperty(options, 'sameSite')) missing.push('sameSite');
  return { missing, definite };
}

function report(node: Node, context: SecurityRuleContext, assessment: CookieAssessment) {
  if (!assessment.missing.length) return;
  const flags = assessment.missing.join(', ');
  const message = `This session cookie is set without ${flags}. Add \`httpOnly: true\` so scripts cannot read it, \`secure: true\` in production and \`sameSite: 'lax'\` or stricter.`;
  context.report(node, ruleId, message, assessment.definite ? undefined : deploymentReason);
}

// `res.cookie(name, value, options)`, `reply.setCookie(...)`, `ctx.cookies.set(...)`,
// `cookie.serialize(...)`.
function cookieCallForm(call: CallExpression, context: SecurityRuleContext): CookieDefaults | undefined {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || call.arguments.length < 2) {
    return serializeForm(call, context);
  }
  const method = callee.name.text;
  const receiver = unwrap(callee.expression);
  if (method === 'cookie' && responseNames.has(chainRootName(receiver) ?? '')) return { httpOnlyDefault: false };
  if (method === 'setCookie') return { httpOnlyDefault: false };
  if (method === 'set' && ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'cookies')
    return { httpOnlyDefault: true };
  return serializeForm(call, context);
}

function serializeForm(call: CallExpression, context: SecurityRuleContext): CookieDefaults | undefined {
  if (call.arguments.length < 2) return;
  const info = context.libraryCall(call);
  const isSerialize = info?.module === 'cookie' && (info.method === 'serialize' || info.exported === 'serialize');
  return isSerialize ? { httpOnlyDefault: false } : undefined;
}

function checkCookieCall(call: CallExpression, context: SecurityRuleContext) {
  const form = cookieCallForm(call, context);
  if (!form) return;
  const [nameArgument, valueArgument, optionsArgument] = call.arguments;
  if (!isSensitiveCookie(nameArgument, valueArgument)) return;
  let options: ObjectLiteralExpression | undefined;
  if (optionsArgument) {
    options = objectLiteralOf(optionsArgument, context.checker);
    if (!options || !isFullyLiteral(options)) return;
  }
  const scriptReadable = scriptReadableNamePattern.test(nameOf(nameArgument));
  const callee = unwrap(call.expression);
  report(
    ts.isPropertyAccessExpression(callee) ? callee.name : callee,
    context,
    assess(options, { ...form, scriptReadable }),
  );
}

function sessionOptions(call: CallExpression, context: SecurityRuleContext) {
  const callee = unwrap(call.expression);
  let factory = ts.isIdentifier(callee) ? callee : undefined;
  let optionsArgument = call.arguments[0];
  const plugin = unwrap(call.arguments[0]);
  if (methodName(call) === 'register' && plugin && ts.isIdentifier(plugin)) {
    factory = plugin;
    optionsArgument = call.arguments[1];
  }
  const module = factory && importedFrom(factory, context.checker)?.module;
  if (!module || !sessionModules.has(module)) return;
  return { options: objectLiteralOf(optionsArgument, context.checker), module };
}

// Session middleware options: `session({ cookie: { secure: false } })`.
function checkSessionCall(call: CallExpression, context: SecurityRuleContext) {
  const session = sessionOptions(call, context);
  if (!session?.options || !isFullyLiteral(session.options)) return;
  const flagged = flagsAtTopLevel.has(session.module)
    ? { node: call, options: session.options }
    : (() => {
        const cookie = findProperty(session.options, 'cookie');
        const options = cookie && objectLiteralOf(cookie.value, context.checker);
        return options && { node: cookie.property, options };
      })();
  if (!flagged || !isFullyLiteral(flagged.options)) return;
  report(flagged.node, context, assess(flagged.options, { httpOnlyDefault: true, scriptReadable: false }));
}

function checkCall(call: CallExpression, context: SecurityRuleContext) {
  checkCookieCall(call, context);
  checkSessionCall(call, context);
}

export { checkCall };
