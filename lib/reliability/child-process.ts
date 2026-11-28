// A child process whose spawn fails (missing binary, no permission, out of memory) emits 'error' on the next tick.
// With no listener the parent process crashes, so every spawned process needs one or must be handed to code that
// has one.
import { ts } from '../performance/compiler.js';
import { walkNodes } from './walk.js';
import { isIgnoredSource } from './source-helpers.js';
import { declaringStatement, findingAt, importedReference, outermostWrapper, referencesTo } from './resource-leaks.js';
import type { CallExpression, Node, SourceFile, VariableDeclaration } from 'typescript';
import type { CheckerAdapter, Finding } from '../shared/types.js';

// exec and execFile report a failed spawn through their callback, so only the callback-free form is a risk.
const alwaysEmitting = new Set(['spawn', 'fork']);
const callbackAccepting = new Set(['exec', 'execFile']);
const listenerMethods = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);

function spawnedMember(call: CallExpression, checker: CheckerAdapter): string | undefined {
  const origin = importedReference(call.expression, checker);
  if (origin?.moduleName !== 'child_process' || origin.members.length !== 1) return;
  const [member] = origin.members;
  if (alwaysEmitting.has(member)) return member;
  const hasCallback = call.arguments.some((argument) => ts.isFunctionLike(argument) || ts.isIdentifier(argument));
  return callbackAccepting.has(member) && !hasCallback ? member : undefined;
}

// `child.on('error', ...)`, or any listener call whose event name is not a literal, which could be this one.
function registersErrorListener(call: CallExpression): boolean {
  const [eventName] = call.arguments;
  if (!eventName) return false;
  return !ts.isStringLiteralLike(eventName) || eventName.text === 'error';
}

// The ways a spawned process is used without being given an error listener or passed on. Any other use of the
// value (argument, return, property assignment, destructuring) hands it to code this rule cannot see.
type Use = 'plain' | 'listener' | 'escapes';

function useOf(reference: Node): Use {
  const node = outermostWrapper(reference);
  const access = node.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== node) return 'escapes';
  const call = access.parent;
  if (!listenerMethods.has(access.name.text)) return 'plain';
  return ts.isCallExpression(call) && call.expression === access && registersErrorListener(call) ? 'listener' : 'plain';
}

function declarationLacksErrorListener(declaration: VariableDeclaration, checker: CheckerAdapter): boolean {
  const statement = declaringStatement(declaration);
  if (!statement || !ts.isIdentifier(declaration.name)) return false;
  return referencesTo(declaration, statement.parent, checker).every((reference) => useOf(reference) === 'plain');
}

// `spawn(...)` on its own, or `spawn(...).unref()`: nothing can have attached a listener.
function resultIsUnheld(call: CallExpression): boolean {
  const node = outermostWrapper(call);
  const parent = node.parent;
  if (ts.isExpressionStatement(parent) || (ts.isVoidExpression(parent) && ts.isExpressionStatement(parent.parent)))
    return true;
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) return false;
  const outer = parent.parent;
  if (!ts.isCallExpression(outer) || outer.expression !== parent) return false;
  if (listenerMethods.has(parent.name.text)) return !registersErrorListener(outer) && isStatement(outer);
  return parent.name.text === 'unref' && isStatement(outer);
}

function isStatement(call: CallExpression): boolean {
  return ts.isExpressionStatement(call.parent);
}

function lacksErrorListener(call: CallExpression, checker: CheckerAdapter): boolean {
  const parent = outermostWrapper(call).parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === outermostWrapper(call))
    return declarationLacksErrorListener(parent, checker);
  return resultIsUnheld(call);
}

function checkChildProcesses(sourceFile: SourceFile, file: string, checker: CheckerAdapter): Finding[] {
  if (!sourceFile.text.includes('child_process') || isIgnoredSource(sourceFile, file)) return [];
  const findings: Finding[] = [];
  walkNodes(sourceFile, (node: Node) => {
    if (!ts.isCallExpression(node)) return;
    const member = spawnedMember(node, checker);
    if (!member || !lacksErrorListener(node, checker)) return;
    findings.push(
      findingAt(
        sourceFile,
        file,
        node,
        'child-process-without-error-listener',
        `This ${member}() child process has no 'error' listener. If the spawn fails (a missing binary, no permission), Node emits 'error' and, with no listener, the parent process crashes. Add child.on('error', ...) or wait with events.once(child, 'exit').`,
      ),
    );
  });
  return findings;
}

export { checkChildProcesses };
