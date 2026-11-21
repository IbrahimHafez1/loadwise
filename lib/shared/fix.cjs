'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { applyFix } = require('../../editor/apply-fix.cjs');
const { scanForFixes } = require('./check.cjs');
const { pillars } = require('./pillars.cjs');
const { realTarget } = require('./real-target.cjs');

const usage = `Usage: loadwise fix (--yes | --all | --handoff) [checkers...]
  --yes    Apply automatic fixes.
  --all    Apply every generated fix, including edits marked for individual review.
  --handoff  Print a read-only Markdown brief for manual findings.
  --review   With --yes or --all, save this run and print a handoff for any coding agent.
  --json   With --yes or --all, print the applied hunks, manual findings and pending review findings as JSON.
  --recipe <name|file.cjs>  With --all, use verified-private-types or a trusted local fix recipe.
  --only   Select checkers by name. Spaces or commas separate multiple names.
  Checkers: performance (perf), maintainability (maint), security (sec).
  Omit checker names to use the project's configured checkers.

  loadwise fix --all
  loadwise fix --yes performance
  loadwise fix --all --only perf,sec`;

function fixOptions(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      yes: { type: 'boolean' },
      all: { type: 'boolean' },
      handoff: { type: 'boolean' },
      review: { type: 'boolean' },
      json: { type: 'boolean' },
      only: { type: 'string', multiple: true },
      recipe: { type: 'string' },
    },
  });
  if (values.handoff && (values.yes || values.all || values.recipe !== undefined))
    throw new Error('--handoff is read-only. Use it separately from --yes, --all and --recipe.');
  if (values.handoff && values.json)
    throw new Error('--handoff prints Markdown. Use check --json for a read-only JSON report.');
  if (values.handoff && values.review) throw new Error('--review requires a fix run with --yes or --all.');
  if (!values.yes && !values.all && !values.handoff) throw new Error(usage);
  if (values.recipe !== undefined && (!values.all || !values.recipe.trim())) {
    throw new Error('--recipe needs --all and a recipe name or local filename.');
  }
  const selected = new Set();
  for (const list of [...(values.only ?? []), ...positionals]) {
    for (const item of list.split(',')) {
      const selector = item.trim();
      const checker = pillars.find(({ name, jsonKey }) => name === selector || jsonKey === selector);
      if (!checker) throw new Error(`Invalid checker "${selector}". Choose performance, maintainability, or security.`);
      selected.add(checker.name);
    }
  }
  return {
    includeReview: Boolean(values.all),
    handoff: Boolean(values.handoff),
    requestReview: Boolean(values.review),
    json: Boolean(values.json),
    recipe: values.recipe,
    selected: selected.size ? [...selected] : undefined,
  };
}

function currentText(filename) {
  try {
    return fs.readFileSync(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function collectChanges(findings, directory) {
  const root = fs.realpathSync.native(directory);
  const changes = new Map();
  for (const finding of findings) {
    for (const change of finding.fix.changes) {
      const file = realTarget(path.resolve(directory, change.file));
      const relative = path.relative(root, file);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error(`Fix #${finding.id} targets a file outside the current project: ${change.file}`);
      }
      // Multiple checkers can propose the exact same import or helper.
      const key = JSON.stringify([file, change.line, change.before, change.after, Boolean(change.create)]);
      changes.set(key, { ...change, file });
    }
  }
  return [...changes.values()];
}

// Disjoint line edits can still introduce two helpers with the same name in one scope.
function validateSource(file, text) {
  if (!/\.[cm]?[jt]sx?$/i.test(file)) return;
  const ts = require('typescript');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  ts.bindSourceFile(source, {});
  const [diagnostic] = [...source.parseDiagnostics, ...source.bindDiagnostics];
  if (diagnostic)
    throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')} No fixes applied.`);
  function duplicateImplementation(node) {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) &&
      node.body &&
      node.symbol?.declarations?.filter((declaration) => declaration.kind === node.kind && declaration.body).length > 1
    ) {
      return node.name?.getText(source) ?? 'constructor';
    }
    return ts.forEachChild(node, duplicateImplementation);
  }
  const duplicate = duplicateImplementation(source);
  if (duplicate) throw new Error(`${file}: duplicate implementation of ${duplicate}. No fixes applied.`);
}

function writeUpdates(updates) {
  const staged = [];
  const written = [];
  try {
    for (const update of updates) {
      const { file, before } = update;
      if (currentText(file) !== before || realTarget(file) !== file)
        throw new Error('File changed while applying fixes: ' + file);
      if (before === undefined) fs.mkdirSync(path.dirname(file), { recursive: true });
      else fs.accessSync(file, fs.constants.W_OK);
      const temporary = path.join(path.dirname(file), '.loadwise-' + randomUUID() + '.tmp');
      const descriptor = fs.openSync(temporary, 'wx');
      staged.push({ ...update, temporary });
      try {
        fs.writeFileSync(descriptor, update.after);
        if (before !== undefined) fs.fchmodSync(descriptor, fs.statSync(file).mode);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    commitStagedUpdates(staged, written);
  } catch (error) {
    const unrestored = [];
    for (const { file, before, after, temporary } of written.reverse()) {
      try {
        if (realTarget(file) !== file || currentText(file) !== after) unrestored.push(file);
        else if (before === undefined) fs.unlinkSync(file);
        else {
          fs.writeFileSync(temporary, before, { flag: 'wx', mode: fs.statSync(file).mode });
          fs.renameSync(temporary, file);
        }
      } catch {
        unrestored.push(file);
      }
    }
    const detail = unrestored.length ? ' Review files that could not be restored: ' + unrestored.join(', ') : '';
    throw new Error(error.message + detail);
  } finally {
    for (const { temporary } of staged) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch (error) {
        console.error(`Could not remove ${temporary}: ${error.message}`);
      }
    }
  }
}

function commitStagedUpdates(staged, written) {
  for (const update of staged) {
    const { file, before, temporary } = update;
    if (currentText(file) !== before || realTarget(file) !== file)
      throw new Error('File changed while applying fixes: ' + file);
    if (before === undefined) fs.copyFileSync(temporary, file, fs.constants.COPYFILE_EXCL);
    else fs.renameSync(temporary, file);
    written.push(update);
  }
}

function writeFixes(findings, directory) {
  const changes = collectChanges(findings, directory);
  if (!changes.length) return 0;
  const originals = new Map();
  const updates = [];
  const result = applyFix(
    { changes },
    {
      readFile(file) {
        const text = currentText(file);
        originals.set(file, text);
        return text;
      },
      writeFile(file, after) {
        validateSource(file, after);
        updates.push({ file, before: originals.get(file), after });
      },
    },
    { exactLocation: true },
  );
  if (result.error)
    throw new Error(result.error + '. No fixes applied. Run loadwise check to choose individual fixes.');
  writeUpdates(updates);
  return updates.length;
}

function location(finding) {
  return `${finding.checker} ${finding.file}:${finding.line} [${finding.ruleId} #${finding.id}]`;
}

function hunkRange(change) {
  return change.create ? [1, Infinity] : [change.line, change.line + change.before.split('\n').length - 1];
}

function applyBulkFixes(findings, directory, { includeReview = false } = {}) {
  const reviewedRanges = new Map();
  const target = (change) => {
    const file = realTarget(path.resolve(directory, change.file));
    return process.platform === 'win32' ? file.toLowerCase() : file;
  };
  for (const finding of findings) {
    if (!finding.fix?.requiresReview) continue;
    for (const change of finding.fix.changes) {
      const file = target(change);
      if (!reviewedRanges.has(file)) reviewedRanges.set(file, []);
      reviewedRanges.get(file).push(hunkRange(change));
    }
  }
  const automatic = [];
  const manual = [];
  const review = [];
  function touchesReviewedLines(change) {
    if (!reviewedRanges.size) return false;
    const [first, last] = hunkRange(change);
    return reviewedRanges.get(target(change))?.some(([start, end]) => first <= end && start <= last);
  }
  for (const finding of findings) {
    if (!finding.fix) manual.push(finding);
    else if (finding.fix.requiresReview || finding.fix.changes.some(touchesReviewedLines)) review.push(finding);
    else automatic.push(finding);
  }
  const applied = includeReview ? [...automatic, ...review] : automatic;
  return { automatic, manual, review, applied, changedFiles: writeFixes(applied, directory) };
}

async function runFix(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(usage);
    return 0;
  }
  const { selected, includeReview, recipe, handoff, json, requestReview } = fixOptions(args);
  const scanned = await scanForFixes(selected);
  if (handoff) {
    console.log(require('./fix-handoff.cjs').formatHandoff(scanned, selected));
    return 0;
  }
  let findings = scanned;
  if (recipe === 'verified-private-types') {
    const { attachVerifiedPrivateTypes } = require('../maintainability/verified-private-types.cjs');
    findings = await attachVerifiedPrivateTypes(scanned, process.cwd());
  } else if (recipe) {
    findings = await require('./fix-recipes.cjs').attachRecipeFixes(scanned, recipe, process.cwd());
  }
  const { applied, manual, review, changedFiles } = applyBulkFixes(findings, process.cwd(), { includeReview });
  const pendingReview = includeReview ? [] : review;
  if (changedFiles) require('./fix-history.cjs').recordBulk(process.cwd(), { applied, manual, pendingReview });
  const instructions = require('./fix-handoff.cjs').fixInstructions(findings.length, selected, manual.length);
  const report = { changedFiles, applied, manual, pendingReview, instructions };
  if (requestReview)
    await require('./review-delivery.cjs').writeReviewHandoff(process.cwd(), 'fix', {
      args,
      format: 'json',
      report,
      exitCode: 0,
    });
  if (json) {
    console.log(JSON.stringify(report));
    return 0;
  }
  if (!includeReview) for (const finding of review) console.log('Review individually: ' + location(finding));
  for (const finding of manual) console.log('Manual change: ' + location(finding));
  for (const finding of applied) console.log('Fixed: ' + location(finding));
  const summary = includeReview
    ? `${applied.length} generated fix(es) in ${changedFiles} file(s), ${manual.length} manual, ${review.length} review-marked fix(es) applied.`
    : `${applied.length} automatic fix(es) in ${changedFiles} file(s), ${manual.length} manual, ${review.length} requiring individual review.`;
  console.log(summary);
  console.log(instructions);
  return 0;
}

module.exports = { runFix, applyBulkFixes, realTarget };
