import { ts } from '../../performance/compiler.js';
import { isContainedPath, hopReason, strip } from './shared.js';
import type { CallExpression } from 'typescript';
import type { SecurityRuleContext } from '../../shared/types.js';

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
function baseWriteName(name: string): string {
  return name.endsWith('Sync') ? name.slice(0, -4) : name;
}

function checkArchiveWrite(call: CallExpression, context: SecurityRuleContext) {
  if (!call.arguments.length) return;
  const callee = strip(call.expression);
  if (ts.isPropertyAccessExpression(callee) && !writeFunctions.has(baseWriteName(callee.name.text))) return;
  const library = context.libraryCall(call);
  const rawName = library?.method ?? library?.exported;
  const writeName = rawName === undefined ? undefined : baseWriteName(rawName);
  if (
    library?.module === undefined ||
    !fsModules.has(library.module) ||
    writeName === undefined ||
    !writeFunctions.has(writeName)
  )
    return;
  const [target] = call.arguments;
  const trace = target && context.taint.trace(target, 'archive-path');
  if (!trace) return;
  if (isContainedPath(call, target, context)) return;
  context.report(call, ruleId, message, hopReason(trace), { taint: trace });
}

export { ruleId, checkArchiveWrite };
