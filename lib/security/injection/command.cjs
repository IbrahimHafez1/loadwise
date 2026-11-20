'use strict';

// `command-injection`: a value reaches a command line that a shell parses. `exec` always uses a shell; `spawn`,
// `execFile` and execa only with a `shell` option or an explicit `sh -c`. Argument injection into a fixed executable
// is out of scope.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { importedFrom } = require('../bindings.cjs');
const { analyzeFragment } = require('../../performance/pg-fragments.cjs');
const { operandsOf } = require('../pg-identifier-guards.cjs');
const { reportTraced, calledExport, initializerOf } = require('./shared.cjs');

const ruleId = 'command-injection';
const untracedReason =
  'The interpolated value is a parameter with no traced caller; confirm no caller passes request data.';
const shellCommands = new Set(['exec', 'execSync']);
const spawnCommands = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync']);
const execaCommands = new Set(['execaCommand', 'execaCommandSync', 'command', 'commandSync']);
const execaSpawns = new Set(['execa', 'execaSync', 'default', 'sync']);
const shellPrograms =
  /^(?:(?:\/usr)?\/bin\/)?(?:sh|bash|zsh|dash|ksh)$|^(?:cmd|cmd\.exe|powershell|powershell\.exe|pwsh)$/i;
const commandFlags = new Set(['-c', '/c', '/C', '-Command', '-command']);

function message(label) {
  return `\`${label}\` reaches a shell command line, so shell metacharacters in it run as commands. Call \`execFile\`/\`spawn\` without \`shell\` and pass the value as an array element.`;
}

// `exec`, or the function `promisify(exec)` returned, as the child_process export name.
function childProcessExport(call, context) {
  const library = context.libraryCall(call);
  if (library?.module === 'child_process') return calledExport(library);
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isIdentifier(callee)) return;
  const initializer = initializerOf(callee, context.checker);
  if (
    !initializer ||
    !ts.isCallExpression(initializer) ||
    calledExport(context.libraryCall(initializer)) !== 'promisify'
  )
    return;
  const wrapped = initializer.arguments[0] && ts.skipOuterExpressions(initializer.arguments[0]);
  if (!wrapped) return;
  const binding = ts.isIdentifier(wrapped)
    ? importedFrom(wrapped, context.checker)
    : ts.isPropertyAccessExpression(wrapped) && ts.isIdentifier(wrapped.expression)
      ? { ...importedFrom(wrapped.expression, context.checker), exported: wrapped.name.text }
      : undefined;
  return binding?.module === 'child_process' ? binding.exported : undefined;
}

function optionsOf(call) {
  const last = call.arguments.at(-1) && ts.skipOuterExpressions(call.arguments.at(-1));
  return last && ts.isObjectLiteralExpression(last) ? last : undefined;
}

// `{ shell: true }` or `{ shell: '/bin/bash' }`.
function usesShell(call) {
  const shell = optionsOf(call)?.properties.find(
    (property) => ts.isPropertyAssignment(property) && property.name.getText() === 'shell',
  );
  const value = shell && ts.skipOuterExpressions(shell.initializer);
  return Boolean(value) && (value.kind === ts.SyntaxKind.TrueKeyword || ts.isStringLiteralLike(value));
}

function argumentList(call) {
  const list = call.arguments[1] && ts.skipOuterExpressions(call.arguments[1]);
  return list && ts.isArrayLiteralExpression(list) ? list : undefined;
}

// The script of `spawn('sh', ['-c', script])`.
function shellScript(call) {
  const program = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  if (!program || !ts.isStringLiteralLike(program) || !shellPrograms.test(program.text)) return;
  const list = argumentList(call);
  const flag = list?.elements.findIndex((element) => ts.isStringLiteralLike(element) && commandFlags.has(element.text));
  return flag >= 0 ? list.elements[flag + 1] : undefined;
}

// The expressions a shell parses for this call.
function shellInputs(call, context) {
  const exported = childProcessExport(call, context);
  const library = exported ? undefined : context.libraryCall(call);
  const name = exported ?? calledExport(library);
  const module = exported ? 'child_process' : library?.module;
  if (module === 'shelljs' && name === 'exec') return [call.arguments[0]];
  if (module === 'execa' && execaCommands.has(name)) return [call.arguments[0]];
  if (module === 'child_process' && shellCommands.has(name)) return [call.arguments[0]];
  const spawns =
    (module === 'child_process' && spawnCommands.has(name)) || (module === 'execa' && execaSpawns.has(name));
  if (!spawns) return [];
  if (usesShell(call)) {
    const list = argumentList(call);
    return [call.arguments[0], ...(list ? list.elements : [call.arguments[1]])];
  }
  return [shellScript(call)];
}

// An interpolated part that is a parameter no traced caller reaches.
function untracedPart(input, context) {
  const value = ts.skipOuterExpressions(input);
  const assembled =
    ts.isTemplateExpression(value) ||
    (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken);
  if (!assembled) return;
  return operandsOf(value).find(
    (part) => analyzeFragment(part, context.checker) === undefined && context.taint.isUntracedParameter(part),
  );
}

function check(call, context) {
  for (const input of shellInputs(call, context)) {
    if (!input || ts.isSpreadElement(input)) continue;
    const trace = context.taint.trace(input, 'shell');
    if (trace) {
      reportTraced(context, input, ruleId, message(trace.label), trace);
      continue;
    }
    const parameter = untracedPart(input, context);
    if (parameter) context.report(input, ruleId, message(parameter.getText()), untracedReason);
  }
}

module.exports = { check };
