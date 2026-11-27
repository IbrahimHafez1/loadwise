// `code-injection`: request data evaluated as JavaScript or loaded as a module.
// `template-injection`: request data compiled as a server-side template, whose expressions run with
// the server's privileges.
import { ts } from '../../performance/compiler.js';
import { reportTraced, isGlobalName, calledExport, initializerOf } from './shared.js';
import type { CallExpression, Expression, NewExpression, Node } from 'typescript';
import type { CheckerAdapter, SecurityRuleContext } from '../../shared/types.js';

const evaluatingGlobals = new Set(['eval', 'Function', 'setTimeout', 'setInterval', 'require']);
const vmFunctions = new Set(['runInNewContext', 'runInContext', 'runInThisContext', 'compileFunction', 'Script']);
const vmAndSerializeMethods = new Set([...vmFunctions, 'unserialize']);
const parameterEvaluators = new Set(['eval', 'Function']);
const parameterReason =
  'Contextual: the evaluated text comes from a function parameter; confirm callers never pass untrusted input.';
// Module -> exports whose first argument is template text.
const templateCompilers: Record<string, ReadonlySet<string>> = {
  ejs: new Set(['render', 'compile']),
  pug: new Set(['render', 'compile']),
  handlebars: new Set(['compile', 'precompile']),
  nunjucks: new Set(['renderString', 'compile']),
  mustache: new Set(['render']),
  lodash: new Set(['template']),
  'lodash.template': new Set(['default']),
  'lodash/template': new Set(['default']),
};
const templateMethodNames = new Set(['render', 'compile', 'precompile', 'renderString', 'template', 'default']);

function codeMessage(label: string) {
  return `\`${label}\` is evaluated as code here. Parse the input as data (\`JSON.parse\`, a schema) or map it to a fixed set of functions.`;
}

function templateMessage(label: string) {
  return `\`${label}\` is compiled as a template, which lets a caller run template code on the server. Keep templates fixed and pass input only as data.`;
}

// `const run = eval;` makes `run(...)` an evaluator call; one hop keeps the lookup bounded.
function resolveAlias(callee: Expression, context: SecurityRuleContext): Expression {
  if (!ts.isIdentifier(callee)) return callee;
  const initializer = initializerOf(callee, context.checker);
  return initializer && ts.isIdentifier(initializer) ? initializer : callee;
}

// The arguments evaluated as code by this call or `new` expression.
function codeInputs(node: CallExpression | NewExpression, context: SecurityRuleContext): (Expression | undefined)[] {
  if (!node.arguments?.length) return [];
  const callee = ts.skipOuterExpressions(node.expression);
  const evaluator = resolveAlias(callee, context);
  if (ts.isCallExpression(node) && callee.kind === ts.SyntaxKind.ImportKeyword) return [node.arguments[0]];
  if (isGlobalName(evaluator, evaluatingGlobals, context.checker)) {
    if (evaluator.text === 'Function') return [...node.arguments];
    if (ts.isNewExpression(node)) return [];
    const [first] = node.arguments;
    // A function passed to a timer is not evaluated as text.
    return first && !ts.isFunctionLike(first) ? [first] : [];
  }
  if (ts.isPropertyAccessExpression(callee) && !vmAndSerializeMethods.has(callee.name.text)) return [];
  const library = context.libraryCall(node);
  const name = calledExport(library);
  if (library?.module === 'vm' && name !== undefined && vmFunctions.has(name)) return [node.arguments[0]];
  if (library?.module === 'node-serialize' && name === 'unserialize') return [node.arguments[0]];
  return [];
}

function templateInput(call: CallExpression, context: SecurityRuleContext) {
  if (!call.arguments.length) return undefined;
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isPropertyAccessExpression(callee) && !templateMethodNames.has(callee.name.text)) return undefined;
  const library = context.libraryCall(call);
  const compiler = library?.module === undefined ? undefined : templateCompilers[library.module];
  const name = calledExport(library);
  return name !== undefined && compiler?.has(name) ? call.arguments[0] : undefined;
}

// Whether any identifier in `expression` is a function parameter, such as the value of a
// `JSON.parse` reviver.
function derivesFromParameter(expression: Expression, checker: CheckerAdapter) {
  let found = false;
  (function visit(node: Node): void {
    if (found) return;
    if (ts.isIdentifier(node)) {
      const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
      found = declarations.some((declaration) => ts.isParameter(declaration));
    }
    ts.forEachChild(node, visit);
  })(expression);
  return found;
}

// `eval`, `Function` and the vm functions only: a parameter reaching `require`, `import` or a timer
// is a common idiom.
function isEvaluatorCall(node: CallExpression | NewExpression, context: SecurityRuleContext) {
  const callee = ts.skipOuterExpressions(node.expression);
  if (isGlobalName(callee, parameterEvaluators, context.checker)) return true;
  return context.libraryCall(node) !== undefined;
}

function checkCode(node: CallExpression | NewExpression, context: SecurityRuleContext) {
  for (const argument of codeInputs(node, context)) {
    // `new Function(...parts)` evaluates whatever the spread supplies.
    const input = argument && ts.isSpreadElement(argument) ? argument.expression : argument;
    if (!input || ts.isStringLiteralLike(input)) continue;
    const trace = context.taint.trace(input, 'code');
    if (trace) reportTraced(context, input, 'code-injection', codeMessage(trace.label), trace);
    else if (isEvaluatorCall(node, context) && derivesFromParameter(input, context.checker))
      reportTraced(context, input, 'code-injection', codeMessage(input.getText()), undefined, parameterReason);
  }
}

function checkTemplate(call: CallExpression, context: SecurityRuleContext) {
  const input = templateInput(call, context);
  if (!input || ts.isStringLiteralLike(input)) return;
  const trace = context.taint.trace(input, 'template');
  if (trace) reportTraced(context, input, 'template-injection', templateMessage(trace.label), trace);
}

export { checkCode, checkTemplate };
