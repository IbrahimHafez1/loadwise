'use strict';

// path-traversal: a file-system path built from request data.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { strip, hasProperty, isResponseReceiver, hopReason, isContainedPath } = require('./shared.cjs');

const ruleId = 'path-traversal';
const message = (label) =>
  `This file path includes \`${label}\`; \`..\` segments can escape the intended directory. Resolve it against the base directory and reject results that do not start with that directory, or use \`path.basename\`.`;
const uploadNameReason =
  'The path uses an uploaded file name; multer (busboy) strips directories from it, so confirm the upload parser does.';
const uploadNameLabel = /\.(?:originalname|originalFilename)\b/;

const fsModules = new Set(['fs', 'fs/promises', 'fs-extra', 'graceful-fs']);
// fs functions whose first argument is a path; Sync and Promise forms share the name without the suffix.
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

function baseName(name) {
  return name?.replace(/Sync$/, '');
}

// The path arguments of an fs call, or of `res.sendFile` / `res.download` / `res.render` without a `root` option.
function pathArguments(call, context) {
  const callee = strip(call.expression);
  if (ts.isPropertyAccessExpression(callee) && isResponseReceiver(callee.expression)) {
    const method = callee.name.text;
    if (method === 'render') return call.arguments.slice(0, 1);
    if (method !== 'sendFile' && method !== 'download') return [];
    // `send` rejects `..` above `root`, so a root option makes the name safe.
    return call.arguments.slice(1).some((argument) => hasProperty(argument, 'root')) ? [] : call.arguments.slice(0, 1);
  }
  const library = context.libraryCall(call);
  if (!library || !fsModules.has(library.module)) return [];
  const name = baseName(library.method ?? library.exported);
  if (onePathFunctions.has(name)) return call.arguments.slice(0, 1);
  if (twoPathFunctions.has(name)) return call.arguments.slice(0, 2);
  return [];
}

function checkFilePath(call, context) {
  for (const argument of pathArguments(call, context)) {
    const trace = context.taint.trace(argument, 'path');
    if (!trace) continue;
    if (isContainedPath(call, argument, context)) continue;
    const reason = hopReason(trace) ?? (uploadNameLabel.test(trace.label) ? uploadNameReason : undefined);
    context.report(call, ruleId, message(trace.label), reason, { taint: trace });
    return;
  }
}

module.exports = { ruleId, checkFilePath };
