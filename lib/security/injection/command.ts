// `command-injection`: a value reaches a command line that a shell parses. `exec` always uses a
// shell; `spawn`,
// `execFile` and execa only with a `shell` option or an explicit `sh -c`. Argument injection into a
// fixed executable is out of scope.
import { ts } from '../../performance/compiler.js';
import { importedFrom } from '../bindings.js';
import { analyzeFragment } from '../../performance/pg-fragments.js';
import { operandsOf } from '../pg-identifier-guards.js';
import { reportTraced, calledExport, initializerOf, fieldWritesOf, positionalArguments } from './shared.js';
import type { CallExpression, Expression, Node, ObjectLiteralExpression } from 'typescript';
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

// An options object written inline or held in a `const`, also behind `const options = base`.
function objectLiteralOf(
  expression: Expression,
  context: SecurityRuleContext,
  visited = new Set<Node>(),
): ObjectLiteralExpression | undefined {
  const value = ts.skipOuterExpressions(expression);
  if (ts.isObjectLiteralExpression(value)) return value;
  if (!ts.isIdentifier(value) || visited.has(value)) return;
  visited.add(value);
  const initializer = initializerOf(value, context.checker);
  return initializer && objectLiteralOf(initializer, context, visited);
}

function optionsOf(args: readonly Expression[], context: SecurityRuleContext) {
  for (let index = args.length - 1; index >= 1; index -= 1)
    if (objectLiteralOf(args[index], context)) return args[index];
  return undefined;
}

function isShellValue(expression: Expression) {
  const value = ts.skipOuterExpressions(expression);
  return value.kind === ts.SyntaxKind.TrueKeyword || ts.isStringLiteralLike(value);
}

// The `shell` setting of an options value: true for `{ shell: true }` or `{ shell: '/bin/bash' }`,
// false when set to anything else, undefined when the options do not set it. A later property,
// spread or `options.shell = ...` write overrides an earlier one. `resolving` holds the values on
// the current path, so a cycle stops without hiding a value spread twice.
function shellSetting(expression: Expression, context: SecurityRuleContext, resolving: Set<Node>): boolean | undefined {
  const value = ts.skipOuterExpressions(expression);
  if (resolving.has(value)) return;
  resolving.add(value);
  try {
    if (ts.isObjectLiteralExpression(value)) return literalShellSetting(value, context, resolving);
    if (!ts.isIdentifier(value)) return;
    const initializer = initializerOf(value, context.checker);
    let setting = initializer ? shellSetting(initializer, context, resolving) : undefined;
    for (const { name, assignment } of fieldWritesOf(value, context.checker))
      if (name === 'shell') setting = isShellValue(assignment.right);
    return setting;
  } finally {
    resolving.delete(value);
  }
}

function literalShellSetting(
  options: ObjectLiteralExpression,
  context: SecurityRuleContext,
  resolving: Set<Node>,
): boolean | undefined {
  let setting: boolean | undefined;
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) {
      setting = shellSetting(property.expression, context, resolving) ?? setting;
      continue;
    }
    if (!ts.isPropertyAssignment(property)) continue;
    if (!(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) || property.name.text !== 'shell')
      continue;
    setting = isShellValue(property.initializer);
  }
  return setting;
}

function usesShell(args: readonly Expression[], context: SecurityRuleContext) {
  const options = optionsOf(args, context);
  return options !== undefined && shellSetting(options, context, new Set()) === true;
}

function argumentList(args: readonly Expression[]) {
  const list = args[1] && ts.skipOuterExpressions(args[1]);
  return list && ts.isArrayLiteralExpression(list) ? list : undefined;
}

// The script of `spawn('sh', ['-c', script])`.
function shellScript(args: readonly Expression[]) {
  const program = args[0] && ts.skipOuterExpressions(args[0]);
  if (!program || !ts.isStringLiteralLike(program) || !shellPrograms.test(program.text)) return;
  const list = argumentList(args);
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
  // `exec(...['echo fixed', options])` runs only the first element.
  const args = positionalArguments(call.arguments);
  if (module === 'shelljs' && name === 'exec') return [args[0]];
  if (name === undefined) return [];
  if (module === 'execa' && execaCommands.has(name)) return [args[0]];
  if (module === 'child_process' && shellCommands.has(name)) return [args[0]];
  const spawns =
    (module === 'child_process' && spawnCommands.has(name)) || (module === 'execa' && execaSpawns.has(name));
  if (!spawns) return [];
  if (usesShell(args, context)) {
    const list = argumentList(args);
    return [args[0], ...(list ? list.elements : [args[1]])];
  }
  return [shellScript(args)];
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
