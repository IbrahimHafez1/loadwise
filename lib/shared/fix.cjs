'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { applyFix } = require('../../editor/apply-fix.cjs');
const { scanForFixes } = require('./check.cjs');
const { pillars } = require('./pillars.cjs');
const { realTarget } = require('./real-target.cjs');
const { introducedSyntaxError, refusalReason } = require('./fix-safety.cjs');

const usage = `Usage: loadwise fix (--yes | --all | --handoff) [checkers...]
  --yes    Apply automatic fixes.
  --all    Apply every generated fix, including edits marked for individual review.
  --handoff  Print a read-only Markdown brief for manual findings.
  --review   With --yes or --all, save this run and print a handoff for any coding agent.
  --json   With --yes or --all, print the applied hunks, manual findings and pending review findings as JSON.
  --recipe <name|file.cjs>  With --all, use verified-private-types or a trusted local fix recipe.
  --only   Select checkers by name. Spaces or commas separate multiple names.
  --no-comments  Do not add the "// Loadwise <rule-id>: <why>" comment above each fixed statement.
  --no-format    Do not format the changed lines with the project's Prettier.
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
      comments: { type: 'boolean' },
      'no-comments': { type: 'boolean' },
      'no-format': { type: 'boolean' },
    },
  });
  if (values.handoff && (values.yes || values.all || values.recipe !== undefined))
    throw new Error('--handoff is read-only. Use it separately from --yes, --all and --recipe.');
  if (values.handoff && values.json)
    throw new Error('--handoff prints Markdown. Use check --json for a read-only JSON report.');
  if (values.handoff && values.review) throw new Error('--review requires a fix run with --yes or --all.');
  if (values.handoff && (values.comments || values['no-comments'] || values['no-format']))
    throw new Error('--comments, --no-comments and --no-format apply to a fix run with --yes or --all.');
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
    comments: !values['no-comments'],
    format: !values['no-format'],
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

// A change's identity: findings that propose the same change share it.
const changeKey = (file, change) =>
  JSON.stringify([file, change.line, change.before, change.after, Boolean(change.create)]);

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
      changes.set(changeKey(file, change), { ...change, file });
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
  const [diagnostic] = source.bindDiagnostics;
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

// Applies the findings' changes in memory. A file whose new text has a syntax error the original lacked is left out
// of `updates` and named in `refusals`; nothing is written here.
function stageFixes(findings, directory) {
  const changes = collectChanges(findings, directory);
  const originals = new Map();
  const updates = [];
  const refusals = new Map();
  const hunksByFile = new Map();
  function capture(change) {
    if (!hunksByFile.has(change.file)) hunksByFile.set(change.file, []);
    hunksByFile.get(change.file).push({
      key: changeKey(change.file, change),
      row: change.line - 1,
      removed: change.create ? 0 : change.before.split('\n').length,
      added: change.after.split('\n').length,
    });
  }
  const result = changes.length
    ? applyFix(
        { changes },
        {
          readFile(file) {
            const text = currentText(file);
            originals.set(file, text);
            return text;
          },
          writeFile(file, after) {
            const syntaxError = introducedSyntaxError(file, originals.get(file), after);
            if (syntaxError) return refusals.set(file, refusalReason(file, syntaxError));
            validateSource(file, after);
            updates.push({ file, before: originals.get(file), after });
          },
        },
        { exactLocation: true, capture },
      )
    : {};
  if (result.error)
    throw new Error(result.error + '. No fixes applied. Run loadwise check to choose individual fixes.');
  return { updates, refusals, hunksByFile };
}

// Findings with a change in a refused file are not applied at all: a fix is all of its changes or none.
function splitRefused(findings, directory, refusals) {
  const kept = [];
  const refused = [];
  for (const finding of findings) {
    const files = finding.fix.changes.map((change) => realTarget(path.resolve(directory, change.file)));
    const blocked = files.find((file) => refusals.has(file));
    if (blocked) refused.push({ finding, reason: refusals.get(blocked) });
    else kept.push(finding);
  }
  return { kept, refused };
}

// A new file must come whole from one fix. When two fixes in a run create the same path (two duplicate groups
// extracting a helper of the same name), the first one keeps it and the later ones wait for the next run, which
// sees the file and picks another name. A later fix proposing the identical file is the same change and stays.
function splitCreateConflicts(findings, directory) {
  const owners = new Map();
  for (const finding of findings) {
    for (const change of finding.fix.changes) {
      if (!change.create) continue;
      const file = realTarget(path.resolve(directory, change.file));
      if (!owners.has(file)) owners.set(file, { finding, key: changeKey(file, change) });
    }
  }
  const kept = [];
  const refused = [];
  for (const finding of findings) {
    const conflict = finding.fix.changes.find((change) => {
      const file = realTarget(path.resolve(directory, change.file));
      const owner = owners.get(file);
      return owner && owner.finding !== finding && changeKey(file, change) !== owner.key;
    });
    if (!conflict) kept.push(finding);
    else {
      const owner = owners.get(realTarget(path.resolve(directory, conflict.file))).finding;
      refused.push({
        finding,
        reason: `#${owner.id} creates ${conflict.file} in this run; run the fix again after it`,
      });
    }
  }
  return { kept, refused };
}

// Two fixes rewriting overlapping lines cannot both apply, such as removals of adjacent index lines that each take
// the line above. The first one keeps its lines and the later ones wait for the next run, which rescans the new
// text, so one collision does not stop every other fix. Fixes sharing an identical change do not conflict.
function splitOverlapConflicts(findings, directory) {
  const claimed = new Map();
  const kept = [];
  const refused = [];
  for (const finding of findings) {
    const ranges = finding.fix.changes
      .filter((change) => !change.create)
      .map((change) => {
        const file = realTarget(path.resolve(directory, change.file));
        const [first, last] = hunkRange(change);
        return { file, first, last, key: changeKey(file, change), change };
      });
    const overlap = (range) =>
      claimed
        .get(range.file)
        ?.find((owner) => owner.key !== range.key && owner.first <= range.last && range.first <= owner.last);
    const conflict = ranges.map((range) => ({ range, owner: overlap(range) })).find(({ owner }) => owner);
    if (conflict) {
      refused.push({
        finding,
        reason: `#${conflict.owner.finding.id} changes ${conflict.range.change.file}:${conflict.range.first} in this run; run the fix again after it`,
      });
      continue;
    }
    kept.push(finding);
    for (const range of ranges) {
      if (!claimed.has(range.file)) claimed.set(range.file, []);
      claimed.get(range.file).push({ ...range, finding });
    }
  }
  return { kept, refused };
}

function writeFixes(findings, directory, format) {
  const conflicts = splitCreateConflicts(findings, directory);
  const overlaps = splitOverlapConflicts(conflicts.kept, directory);
  let remaining = overlaps.kept;
  const refused = [...conflicts.refused, ...overlaps.refused];
  for (;;) {
    const { updates, refusals, hunksByFile } = stageFixes(remaining, directory);
    if (!refusals.size) {
      if (format) showFormattedChanges(remaining, directory, updates, hunksByFile);
      writeUpdates(updates);
      return { applied: remaining, refused, changedFiles: updates.length };
    }
    const split = splitRefused(remaining, directory, refusals);
    refused.push(...split.refused);
    remaining = split.kept;
  }
}

// Formats the changed lines before they are written, and shows each applied change as it now reads.
function showFormattedChanges(findings, directory, updates, hunksByFile) {
  const formatted = require('./fix-presentation.cjs').formatUpdates(
    directory,
    updates.map((update) => ({ ...update, hunks: hunksByFile.get(update.file) ?? [] })),
  );
  // The fixes were checked for syntax before formatting; a file that formatting breaks is written unformatted.
  const unformatted = new Set();
  for (const update of updates) {
    const text = formatted.texts.get(update.file);
    if (text === undefined) continue;
    if (introducedSyntaxError(update.file, update.before, text)) unformatted.add(update.file);
    else update.after = text;
  }
  for (const finding of findings) {
    for (const change of finding.fix.changes) {
      const file = realTarget(path.resolve(directory, change.file));
      if (unformatted.has(file)) continue;
      const hunk = formatted.hunks.get(changeKey(file, change));
      if (hunk) Object.assign(change, hunk);
    }
  }
}

function location(finding) {
  return `${finding.checker} ${finding.file}:${finding.line} [${finding.ruleId} #${finding.id}]`;
}

// Applied fixes with why their rule changed the code, said once per rule, and each fix's note on why it changed its
// site this way. Notes name the site's own code, so they stay per fix.
function printFixed(applied) {
  const { labelledLines } = require('./fix-terminal.cjs');
  const { ruleWhy } = require('./fix-presentation.cjs');
  const { groupByReason } = require('./reason-groups.cjs');
  const printNote = (finding, indentation) => {
    if (!finding.fix.note) return;
    for (const line of labelledLines('Note', finding.fix.note, indentation)) console.log(line);
  };
  for (const group of groupByReason(applied, (finding) => finding.ruleId)) {
    const [first] = group;
    const why = ruleWhy(first.ruleId);
    if (group.length === 1) {
      console.log('Fixed: ' + location(first));
      if (why) for (const line of labelledLines('Why', why)) console.log(line);
      printNote(first, '  ');
      continue;
    }
    console.log(`Fixed ${group.length} [${first.ruleId}]:`);
    if (why) for (const line of labelledLines('Why', why)) console.log(line);
    for (const finding of group) {
      console.log(`  ${finding.checker} ${finding.file}:${finding.line} #${finding.id}`);
      printNote(finding, '    ');
    }
  }
}

function hunkRange(change) {
  return change.create ? [1, Infinity] : [change.line, change.line + change.before.split('\n').length - 1];
}

function applyBulkFixes(findings, directory, { includeReview = false, format = false } = {}) {
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
  const written = writeFixes(includeReview ? [...automatic, ...review] : automatic, directory, format);
  return { automatic, manual, review, ...written };
}

async function runFix(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(usage);
    return 0;
  }
  const { selected, includeReview, recipe, handoff, json, requestReview, comments, format } = fixOptions(args);
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
  if (!comments) {
    const { withoutWhyComment } = require('./fix-presentation.cjs');
    findings = findings.map((finding) =>
      finding.fix ? { ...finding, fix: withoutWhyComment(finding.fix, finding.ruleId) } : finding,
    );
  }
  const { applied, manual, review, refused, changedFiles } = applyBulkFixes(findings, process.cwd(), {
    includeReview,
    format,
  });
  const pendingReview = includeReview ? [] : review;
  if (changedFiles) require('./fix-history.cjs').recordBulk(process.cwd(), { applied, manual, pendingReview });
  const instructions = require('./fix-handoff.cjs').fixInstructions(findings.length, selected, manual.length);
  const notApplied = refused.map(({ finding, reason }) => ({ id: finding.id, ruleId: finding.ruleId, reason }));
  const report = { changedFiles, applied, manual, pendingReview, notApplied, instructions };
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
  for (const { finding, reason } of refused) console.log(`Not applied: ${location(finding)}: ${reason}`);
  printFixed(applied);
  const summary = includeReview
    ? `${applied.length} generated fix(es) in ${changedFiles} file(s), ${manual.length} manual, ${review.length} review-marked fix(es) applied.`
    : `${applied.length} automatic fix(es) in ${changedFiles} file(s), ${manual.length} manual, ${review.length} requiring individual review.`;
  console.log(summary);
  console.log(instructions);
  return 0;
}

module.exports = { runFix, applyBulkFixes, realTarget };
