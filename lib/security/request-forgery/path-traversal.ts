// path-traversal: a file-system path built from request data.
import { ts } from '../../performance/compiler.js';
import { classifyExecutionContext } from '../../shared/execution-context.js';
import { strip, hasProperty, isResponseReceiver, hopReason, isContainedPath, isProjectValidated } from './shared.js';
import type { CallExpression, Expression } from 'typescript';
import type { SecurityRuleContext } from '../../shared/types.js';

const ruleId = 'path-traversal';
const message = (label: string) =>
  `This file path includes \`${label}\`. Check that its resolved location stays inside the intended directory, or validate the entire filename against the application's allowed format before opening it.`;
const uploadNameReason =
  'The path uses an uploaded file name; multer (busboy) strips directories from it, so confirm the upload parser does.';
const uploadNameLabel = /\.(?:originalname|originalFilename)\b/;

// Project helpers that check a path, or pin an id so that no separator remains (see
// lib/shared/function-summaries.cjs).
const validatedKinds = ['path', 'id'];
const fsModules = new Set(['fs', 'fs/promises', 'fs-extra', 'graceful-fs']);
// fs functions whose first argument is a path; Sync and Promise forms share the name without the
// suffix.
const onePathFunctions = new Set([
  'access',
  'appendFile',
  'chmod',
  'chown',
  'createReadStream',
  'createWriteStream',
  'emptyDir',
  'ensureDir',
  'ensureFile',
  'lstat',
  'mkdir',
  'mkdirp',
  'mkdirs',
  'open',
  'opendir',
  'outputFile',
  'outputJson',
  'readFile',
  'readJson',
  'readdir',
  'readlink',
  'realpath',
  'remove',
  'rm',
  'rmdir',
  'stat',
  'truncate',
  'unlink',
  'utimes',
  'writeFile',
  'writeJson',
]);
// fs functions that take a source and a destination path.
const twoPathFunctions = new Set(['copy', 'copyFile', 'cp', 'link', 'move', 'rename', 'symlink']);
const allPathFunctions = new Set([...onePathFunctions, ...twoPathFunctions]);

function baseName(name: string | undefined) {
  return name?.endsWith('Sync') ? name.slice(0, -4) : name;
}

// The path arguments of an fs call, or of `res.sendFile` / `res.download` / `res.render` without a
// `root` option.
function pathArguments(call: CallExpression, context: SecurityRuleContext): readonly Expression[] {
  if (!call.arguments.length) return [];
  const callee = strip(call.expression);
  if (ts.isPropertyAccessExpression(callee) && isResponseReceiver(callee.expression)) {
    const method = callee.name.text;
    if (method === 'render') return call.arguments.slice(0, 1);
    if (method !== 'sendFile' && method !== 'download') return [];
    // `send` rejects `..` above `root`, so a root option makes the name safe.
    return call.arguments.slice(1).some((argument: Expression) => hasProperty(argument, 'root'))
      ? []
      : call.arguments.slice(0, 1);
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const base = baseName(callee.name.text);
    if (base === undefined || !allPathFunctions.has(base)) return [];
  }
  const library = context.libraryCall(call);
  if (!library || library.module === undefined || !fsModules.has(library.module)) return [];
  const name = baseName(library.method ?? library.exported);
  if (name === undefined) return [];
  if (onePathFunctions.has(name)) return call.arguments.slice(0, 1);
  if (twoPathFunctions.has(name)) return call.arguments.slice(0, 2);
  return [];
}

function checkFilePath(call: CallExpression, context: SecurityRuleContext) {
  for (const argument of pathArguments(call, context)) {
    const trace = context.taint.trace(argument, 'path');
    if (!trace) continue;
    if (isContainedPath(call, argument, context) || isProjectValidated(call, argument, validatedKinds, context))
      continue;
    const runtime = classifyExecutionContext(context.sourceFile).runtime;
    const reason =
      (runtime === 'cli-tooling' ? 'Runs in CLI or developer tooling rather than a server request path.' : undefined) ??
      hopReason(trace) ??
      (uploadNameLabel.test(trace.label) ? uploadNameReason : undefined);
    context.report(call, ruleId, message(trace.label), reason, { taint: trace });
    return;
  }
}

export { ruleId, checkFilePath };
