// service-query-in-loop: the query sits in a project helper called once per item. When the helper
// is a single keyed read or a single insert, a batch sibling is added next to it and the loop calls
// that once; a loop that only awaits the helper otherwise runs its calls a few at a time.
import { ts, calleeCall, freshName, indentationAt, isPlainReference, textOf } from './helpers.js';
import { unwrap, contains, lastSegment } from './service-loop-ast.js';
import { clientFamily, relatedLocations, directCallee } from './service-loop-callee.js';
import { readBatch, pluralOf } from './service-loop-read-batch.js';
import { writeBatch, writeLines } from './service-loop-write-batch.js';
import {
  promiseAllSite,
  awaitedStatement,
  soleLoopSite,
  prefetchSite,
  varyingArgument,
  listExpression,
  batchCallText,
} from './service-loop-sites.js';
import { batchTarget, callableFrom } from './service-loop-siblings.js';
import { inImportEdit, crossFileImport } from './service-loop-imports.js';
import { concurrentFix } from './service-loop-concurrent.js';
import type { CallExpression, Expression, Node, SourceFile } from 'typescript';
import type { CalleeHelper } from '../types/callee-helper.js';
import type { ReadBatch, BatchPlan } from '../types/batch-plan.js';
import type { CallSite } from '../types/call-site.js';
import type { BatchedFixInput } from '../types/batched-fix-input.js';
import type { FileTarget, FixResult, SiteFixInput, TextEdit } from '../../shared/types.js';

const typedExtensions = /\.[cm]?tsx?$/i;

interface SiteEditsInput {
  site: CallSite;
  call: CallExpression;
  batch: string;
  itemIndex: number;
  argument: Expression;
  read: ReadBatch | undefined;
  sourceFile: SourceFile;
  typed: boolean;
}

function insertMethod(callee: CalleeHelper, batchName: string, lines: string[]): TextEdit {
  const { declaration } = callee;
  return {
    start: declaration.end,
    end: declaration.end,
    text: '\n\n' + lines.join('\n').replace('BATCH_NAME', batchName),
  };
}

function targetsOf(editsByFile: ReadonlyMap<string, TextEdit[]>): FileTarget[] {
  return [...editsByFile].map(([file, edits]) => ({ file, edits }));
}

function addEdits(editsByFile: Map<string, TextEdit[]>, file: string, edits: TextEdit[]): void {
  editsByFile.set(file, [...(editsByFile.get(file) ?? []), ...edits]);
}

// loadwise-reviewed high-branch-complexity -- a linear chain of independent bail-outs (family, callee, site, argument, target, import) before one rewrite; each guard depends on the previous result so splitting adds only plumbing
function batchedFix({ finding, call, sourceFile, load }: BatchedFixInput): FixResult | undefined {
  const family = clientFamily(finding.message);
  const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : textOf(call.expression);
  const related = relatedLocations(finding);
  const callee = family && directCallee(related, name, load);
  if (!family || !callee || related?.length !== 1 || finding.file === undefined) return;
  const crossFile = ts.isFunctionDeclaration(callee.declaration) && callee.entry.sourceFile !== sourceFile;
  const typed = typedExtensions.test(callee.entry.sourceFile.fileName);
  const siteTyped = typedExtensions.test(sourceFile.fileName);
  const read = readBatch(callee, family, typed);
  const write = read ? undefined : writeBatch(callee, family, typed);
  const plan = read ?? write;
  if (!plan) return;
  const site =
    promiseAllSite(call) ?? (write ? soleLoopSite(call) : undefined) ?? (read?.bare ? prefetchSite(call) : undefined);
  if (!site) return;
  const varying = varyingArgument(call, site);
  if (!varying || call.arguments.length !== callee.declaration.parameters.length) return;
  const itemIndex = read ? read.itemIndex : varying.index;
  if (varying.index !== itemIndex) return;
  if (write && !write.used.includes(write.parameterNames[itemIndex])) return;
  if (site.kind === 'all' && write && !ts.isExpressionStatement(awaitedStatement(site.all)?.parent ?? site.all.parent))
    return;
  const listName = read ? read.listName : pluralOf(plan.parameterNames[itemIndex]);
  if (write && contains(callee.declaration, (node: Node) => ts.isIdentifier(node) && node.text === listName)) return;
  const lines = read ? read.lines : write && writeLines(callee, write, itemIndex, listName);
  if (!lines) return;
  const target = batchTarget(callee, lines, write, itemIndex);
  if (!target || (target.existing && !callableFrom(target.existing, call))) return;
  const batch = target.name;
  const imported = crossFile && crossFileImport(callee, call, sourceFile, batch);
  if (crossFile && !imported) return;
  const siteEditList = siteEdits({
    site,
    call,
    batch,
    itemIndex,
    argument: varying.argument,
    read,
    sourceFile,
    typed: siteTyped,
  });
  if (!siteEditList) return;
  const editsByFile = new Map<string, TextEdit[]>();
  addEdits(editsByFile, finding.file, [...(imported || []), ...siteEditList]);
  const calleeFile = callee.entry.filename;
  if (!target.existing) {
    addEdits(editsByFile, calleeFile, [insertMethod(callee, batch, lines)]);
    if (read?.needsIn) {
      const importEdit = inImportEdit(callee.entry.sourceFile);
      if (!importEdit) return;
      addEdits(editsByFile, calleeFile, importEdit.edits);
    }
  }
  return { targets: targetsOf(editsByFile), note: batchNote(site, plan, batch, !!target.existing) };
}

function siteEdits({
  site,
  call,
  batch,
  itemIndex,
  argument,
  read,
  sourceFile,
  typed,
}: SiteEditsInput): TextEdit[] | undefined {
  const list = listExpression(site, argument, typed);
  if (site.kind === 'all')
    return [
      { start: site.all.getStart(sourceFile), end: site.all.end, text: batchCallText(call, batch, itemIndex, list) },
    ];
  if (site.kind === 'loop')
    return [
      {
        start: site.loop.getStart(sourceFile),
        end: site.loop.end,
        text: `await ${batchCallText(call, batch, itemIndex, list)};`,
      },
    ];
  // Prefetch: the key is evaluated again inside the loop, so it must be free of side effects.
  if (!read || !isPlainReference(unwrap(argument)) || !isPlainReference(unwrap(site.collection))) return;
  const keys = freshName(sourceFile, read.listName);
  const byKey = freshName(sourceFile, `${lastSegment(textOf(call.expression))}ByKey`);
  if (!keys || !byKey) return;
  const fallback = read.single ? 'null' : '[]';
  const lookup = `${byKey}.get(${textOf(argument)}) ?? ${fallback}`;
  const parent = site.awaited.parent;
  const inline = ts.isVariableDeclaration(parent) || ts.isReturnStatement(parent) ? lookup : `(${lookup})`;
  const indentation = indentationAt(sourceFile.text, site.loop.getStart(sourceFile));
  const prefetch = [
    `const ${keys} = ${list};`,
    `const ${byKey} = new Map((await ${batchCallText(call, batch, itemIndex, keys)}).map((result, index) => [${keys}[index], result]));`,
  ];
  const anchor = ts.isLabeledStatement(site.loop.parent) ? site.loop.parent : site.loop;
  const loopStart = anchor.getStart(sourceFile);
  return [
    { start: loopStart, end: loopStart, text: prefetch.join('\n' + indentation) + '\n' + indentation },
    { start: site.awaited.getStart(sourceFile), end: site.awaited.end, text: inline },
  ];
}

function batchNote(site: CallSite, plan: BatchPlan, batch: string, existing: boolean): string {
  const verb = existing ? 'Calls the existing' : 'Adds';
  if (plan.kind === 'read') {
    const timing =
      site.kind === 'prefetch'
        ? ' All keys are read before the loop, so rows the loop writes before reading them are not seen, and items the loop skips are still fetched.'
        : '';
    return `${verb} ${batch}(): ${plan.note}${timing}`;
  }
  return `${verb} ${batch}(), which writes all rows in one statement after the loop instead of one per item. The batch is all-or-nothing (a failing row no longer leaves the earlier rows written), ${
    plan.batchCall('x', 'y').includes('createMany')
      ? 'createMany does not run nested writes or return the rows, '
      : 'entity listeners still run per row, '
  }and the rows are written when the loop would have finished.`;
}

function serviceLoopFix({ finding, node, sourceFile, load }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const call = calleeCall(node);
  if (!call) return;
  return batchedFix({ finding, call, sourceFile, load }) ?? concurrentFix({ finding, call, sourceFile });
}

export default { 'service-query-in-loop': serviceLoopFix };
