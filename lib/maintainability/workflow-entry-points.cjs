'use strict';

const path = require('node:path');

const jobsBlock = /^jobs:\s*(?:#.*)?$/;
const stepsBlock = /^steps:\s*(?:#.*)?$/;
const jobBlock = /^[\w-]+:\s*(?:#.*)?$/;
const runKey = /^run:\s+(.*)$/;
const literalBlock = /^\|[+-]?\s*(?:#.*)?$/;
const workflowDefaults = /^(?:['"]?defaults['"]?|<<)\s*:/;
const stepOverrides = /^(?:['"]?(?:working-directory|shell|uses)['"]?|<<)\s*:/;
const nodeCommand = /^node +(?:([\w./-]+)|'([\w./-]+)'|"([\w./-]+)")(?: +&)?(?: +#.*)? *$/;
const sourceExtension = /\.[cm]?[jt]sx?$/;

// Only the workflow's block structure is needed. A block is one header followed by its indented children.
function* directBlocks(lines) {
  if (!lines.length) return;
  const indentation = lines.reduce((minimum, line) => Math.min(minimum, line.indentation), lines[0].indentation);
  for (let start = 0; start < lines.length;) {
    let end = start + 1;
    while (end < lines.length && lines[end].indentation > indentation) end++;
    yield { indentation, header: lines[start].text, children: lines.slice(start + 1, end) };
    start = end;
  }
}

function literalNodePath(step) {
  const firstField = { indentation: step.indentation + 2, text: step.header.slice(2) };
  const fields = [...directBlocks([firstField, ...step.children])];
  if (fields.some(({ header }) => stepOverrides.test(header))) return;
  const [run, extraRun] = fields.filter(({ header }) => runKey.test(header));
  if (!run || extraRun) return;
  const [, value] = runKey.exec(run.header);
  // Ignore compound shell scripts, folded YAML and expressions rather than guessing which file runs.
  const command = literalBlock.test(value) && run.children.length === 1 ? run.children[0].text : undefined;
  if (!command && run.children.length) return;
  const matched = nodeCommand.exec(command ?? value);
  const target = matched?.slice(1).find(Boolean);
  if (!target || target.startsWith('-') || !sourceExtension.test(target)) return;
  const relative = path.posix.normalize(target);
  if (!path.posix.isAbsolute(relative) && !relative.startsWith('../')) return relative;
}

function* workflowNodeEntries(text) {
  if (!text) return;
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    const matched = /^( *)([^ \t#].*)$/.exec(line);
    if (matched) lines.push({ indentation: matched[1].length, text: matched[2].trimEnd() });
  }
  const workflow = [...directBlocks(lines)];
  if (workflow.some(({ header }) => workflowDefaults.test(header))) return;
  const jobs = workflow.find(({ header }) => jobsBlock.test(header));
  if (!jobs) return;
  for (const job of directBlocks(jobs.children)) {
    if (!jobBlock.test(job.header)) continue;
    const settings = [...directBlocks(job.children)];
    if (settings.some(({ header }) => workflowDefaults.test(header))) continue;
    const steps = settings.find(({ header }) => stepsBlock.test(header));
    if (!steps) continue;
    for (const step of directBlocks(steps.children)) {
      if (!step.header.startsWith('- ')) continue;
      const entry = literalNodePath(step);
      if (entry) yield entry;
    }
  }
}

module.exports = { workflowNodeEntries };
