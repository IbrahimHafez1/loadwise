// `command-injection`: a value reaches a command line that a shell parses. `exec` always uses a
// shell; `spawn`,
// `execFile` and execa only with a `shell` option or an explicit `sh -c`. Argument injection into a
// fixed executable is out of scope.
import { ts } from '../../performance/compiler.js';
import { importedFrom } from '../bindings.js';
import { analyzeFragment } from '../../performance/pg-fragments.js';
import { operandsOf } from '../pg-identifier-guards.js';
import { reportTraced, calledExport, initializerOf } from './shared.js';
import type { CallExpression, Expression, ObjectLiteralExpression } from 'typescript';
import type { SecurityRuleContext } from '../../shared/types.js';

const ruleId = 'command-injection';
const untracedReason =
  'The interpolated value is a parameter with no traced caller; confirm no caller passes request data.';
const shellCommands = new Set(['exec', 'execSync']);
const spawnCommands = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync']);
const execaCommands = new Set(['execaCommand', 'execaCommandSync', 'command', 'commandSync']);
const execaSpawns = new Set(['execa', 'execaSync', 'default', 'sync']);
const allCommandMethods = new Set([...shellCommands, ...spawnCommands, ...execaCommands, ...execaSpawns]);
const shellPrograms =
  /^(?:(?:\/usr)?\/bin\/)?(?:sh|bash|zsh|dash|ksh)$|^(?:cmd|cmd\.exe|powershell|powershell\.exe|pwsh)$/i;
const commandFlags = new Set(['-c', '/c', '/C', '-Command', '-command']);
const maxOptionsDepth = 3;

function message(label: string) {
  return `\`${label}\` reaches a shell command line, so shell metacharacters in it run as commands. Call \`execFile\`/\`spawn\` without \`shell\` and pass the value as an array element.`;
}

// `exec`, or the function `promisify(exec)` returned, as the child_process export name.
function childProcessExport(call: CallExpression, context: SecurityRuleContext): string | undefined {
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

// An options object written inline or held in a `const`.
function objectLiteralOf(expression: Expression, context: SecurityRuleContext) {
  const value = ts.skipOuterExpressions(expression);
  if (ts.isObjectLiteralExpression(value)) return value;
  const initializer = ts.isIdentifier(value) ? initializerOf(value, context.checker) : undefined;
  return initializer && ts.isObjectLiteralExpression(initializer) ? initializer : undefined;
}

function optionsOf(call: CallExpression, context: SecurityRuleContext) {
  for (let index = call.arguments.length - 1; index >= 1; index -= 1) {
    const options = objectLiteralOf(call.arguments[index], context);
    if (options) return options;
  }
  return undefined;
}

// `{ shell: true }` or `{ shell: '/bin/bash' }`, written in the options or spread into them. A later
// property overrides an earlier one, so the last `shell` wins.
function enablesShell(options: ObjectLiteralExpression, context: SecurityRuleContext, depth = 0): boolean {
  let enabled = false;
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = depth < maxOptionsDepth ? objectLiteralOf(property.expression, context) : undefined;
      if (spread) enabled = enablesShell(spread, context, depth + 1) || enabled;
      continue;
    }
    if (!ts.isPropertyAssignment(property)) continue;
    if (!(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) || property.name.text !== 'shell')
      continue;
    const value = ts.skipOuterExpressions(property.initializer);
    enabled = value.kind === ts.SyntaxKind.TrueKeyword || ts.isStringLiteralLike(value);
  }
  return enabled;
}

function usesShell(call: CallExpression, context: SecurityRuleContext) {
  const options = optionsOf(call, context);
  return options !== undefined && enablesShell(options, context);
}

function argumentList(call: CallExpression) {
  const list = call.arguments[1] && ts.skipOuterExpressions(call.arguments[1]);
  return list && ts.isArrayLiteralExpression(list) ? list : undefined;
}

// The script of `spawn('sh', ['-c', script])`.
function shellScript(call: CallExpression) {
  const program = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  if (!program || !ts.isStringLiteralLike(program) || !shellPrograms.test(program.text)) return;
  const list = argumentList(call);
  if (!list) return;
  const flag = list.elements.findIndex((element) => ts.isStringLiteralLike(element) && commandFlags.has(element.text));
  return flag >= 0 ? list.elements[flag + 1] : undefined;
}

// The expressions a shell parses for this call.
function shellInputs(call: CallExpression, context: SecurityRuleContext): (Expression | undefined)[] {
  if (!call.arguments.length) return [];
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isPropertyAccessExpression(callee) && !allCommandMethods.has(callee.name.text)) return [];
  const exported = childProcessExport(call, context);
  const library = exported ? undefined : context.libraryCall(call);
  const name = exported ?? calledExport(library);
  const module = exported ? 'child_process' : library?.module;
  if (module === 'shelljs' && name === 'exec') return [call.arguments[0]];
  if (name === undefined) return [];
  if (module === 'execa' && execaCommands.has(name)) return [call.arguments[0]];
  if (module === 'child_process' && shellCommands.has(name)) return [call.arguments[0]];
  const spawns =
    (module === 'child_process' && spawnCommands.has(name)) || (module === 'execa' && execaSpawns.has(name));
  if (!spawns) return [];
  if (usesShell(call, context)) {
    const list = argumentList(call);
    return [call.arguments[0], ...(list ? list.elements : [call.arguments[1]])];
  }
  return [shellScript(call)];
}

// An interpolated part that is a parameter no traced caller reaches.
function untracedPart(input: Expression, context: SecurityRuleContext) {
  const value = ts.skipOuterExpressions(input);
  const assembled =
    ts.isTemplateExpression(value) ||
    (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken);
  if (!assembled) return;
  return operandsOf(value).find(
    (part) => analyzeFragment(part, context.checker) === undefined && context.taint.isUntracedParameter(part),
  );
}

function check(call: CallExpression, context: SecurityRuleContext) {
  for (const argument of shellInputs(call, context)) {
    // `exec(...[command])` runs whatever the spread supplies.
    const input = argument && ts.isSpreadElement(argument) ? argument.expression : argument;
    if (!input) continue;
    const trace = context.taint.trace(input, 'shell');
    if (trace) {
      reportTraced(context, input, ruleId, message(trace.label), trace);
      continue;
    }
    const parameter = untracedPart(input, context);
    if (parameter) context.report(input, ruleId, message(parameter.getText()), untracedReason);
  }
}

export { check };
