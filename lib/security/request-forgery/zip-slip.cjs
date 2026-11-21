'use strict';

const { isContainedPath, hopReason } = require('./shared.cjs');

const ruleId = 'zip-slip-extraction';
const message =
  'This archive entry name is joined into a write path without a containment check. Resolve the path and skip entries that leave the destination directory.';

const fsModules = new Set(['fs', 'fs/promises', 'fs-extra', 'graceful-fs']);
const writeFunctions = new Set([
  'appendFile',
  'createWriteStream',
  'ensureDir',
  'ensureFile',
  'mkdir',
  'mkdirp',
  'mkdirs',
  'outputFile',
  'writeFile',
]);
function checkArchiveWrite(call, context) {
  const library = context.libraryCall(call);
  if (
    !fsModules.has(library?.module) ||
    !writeFunctions.has((library.method ?? library.exported)?.replace(/Sync$/, ''))
  )
    return;
  const [target] = call.arguments;
  const trace = target && context.taint.trace(target, 'archive-path');
  if (!trace) return;
  if (isContainedPath(call, target, context)) return;
  context.report(call, ruleId, message, hopReason(trace), { taint: trace });
}

module.exports = { ruleId, checkArchiveWrite };
