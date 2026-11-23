'use strict';

// `code-injection`: request data evaluated as JavaScript or loaded as a module. `template-injection`: request data
// compiled as a server-side template, whose expressions run with the server's privileges.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { reportTraced, isGlobalName, calledExport } = require('./shared.cjs');

const evaluatingGlobals = new Set(['eval', 'Function', 'setTimeout', 'setInterval', 'require']);
const vmFunctions = new Set(['runInNewContext', 'runInContext', 'runInThisContext', 'compileFunction', 'Script']);
const parameterEvaluators = new Set(['eval', 'Function']);
const parameterReason =
  'Contextual: the evaluated text comes from a function parameter; confirm callers never pass untrusted input.';
// Module -> exports whose first argument is template text.
const templateCompilers = {
  ejs: new Set(['render', 'compile']),
  pug: new Set(['render', 'compile']),
  handlebars: new Set(['compile', 'precompile']),
  nunjucks: new Set(['renderString', 'compile']),
  mustache: new Set(['render']),
  lodash: new Set(['template']),
  'lodash.template': new Set(['default']),
  'lodash/template': new Set(['default']),
};

function codeMessage(label) {
  return `\`${label}\` is evaluated as code here. Parse the input as data (\`JSON.parse\`, a schema) or map it to a fixed set of functions.`;
}

function templateMessage(label) {
  return `\`${label}\` is compiled as a template, which lets a caller run template code on the server. Keep templates fixed and pass input only as data.`;
}

// The arguments evaluated as code by this call or `new` expression.
function codeInputs(node, context) {
  const callee = ts.skipOuterExpressions(node.expression);
  if (ts.isCallExpression(node) && callee.kind === ts.SyntaxKind.ImportKeyword) return [node.arguments[0]];
  if (isGlobalName(callee, evaluatingGlobals, context.checker)) {
    if (callee.text === 'Function') return [...(node.arguments ?? [])];
    if (ts.isNewExpression(node)) return [];
    const [first] = node.arguments;
    // A function passed to a timer is not evaluated as text.
    return first && !ts.isFunctionLike(first) ? [first] : [];
  }
  const library = context.libraryCall(node);
  const name = calledExport(library);
  if (library?.module === 'vm' && vmFunctions.has(name)) return [node.arguments?.[0]];
  if (library?.module === 'node-serialize' && name === 'unserialize') return [node.arguments?.[0]];
  return [];
}

function templateInput(call, context) {
  const library = context.libraryCall(call);
  return templateCompilers[library?.module]?.has(calledExport(library)) ? call.arguments[0] : undefined;
}

// Whether any identifier in `expression` is a function parameter, such as the value of a `JSON.parse` reviver.
function derivesFromParameter(expression, checker) {
  let found = false;
  (function visit(node) {
    if (found) return;
    if (ts.isIdentifier(node)) {
      const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
      found = declarations.some((declaration) => ts.isParameter(declaration));
    }
    ts.forEachChild(node, visit);
  })(expression);
  return found;
}

// `eval`, `Function` and the vm functions only: a parameter reaching `require`, `import` or a timer is a common idiom.
function isEvaluatorCall(node, context) {
  const callee = ts.skipOuterExpressions(node.expression);
  if (isGlobalName(callee, parameterEvaluators, context.checker)) return true;
  return context.libraryCall(node) !== undefined;
}

function checkCode(node, context) {
  for (const input of codeInputs(node, context)) {
    if (!input || ts.isSpreadElement(input) || ts.isStringLiteralLike(input)) continue;
    const trace = context.taint.trace(input, 'code');
    if (trace) reportTraced(context, input, 'code-injection', codeMessage(trace.label), trace);
    else if (isEvaluatorCall(node, context) && derivesFromParameter(input, context.checker))
      reportTraced(context, input, 'code-injection', codeMessage(input.getText()), undefined, parameterReason);
  }
}

function checkTemplate(call, context) {
  const input = templateInput(call, context);
  if (!input || ts.isStringLiteralLike(input)) return;
  const trace = context.taint.trace(input, 'template');
  if (trace) reportTraced(context, input, 'template-injection', templateMessage(trace.label), trace);
}

module.exports = { checkCode, checkTemplate };
