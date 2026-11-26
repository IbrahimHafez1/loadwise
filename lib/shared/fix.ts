import path from 'node:path';
import { parseArgs } from 'node:util';
import { scanForFixes } from './check.js';
import { pillars } from './pillars.js';
import { realTarget } from './real-target.js';
import type { Finding, FixChange } from './types.js';
import type { FileUpdate, FixableFinding } from './types/fix-run.js';
import { ruleWhy, withoutWhyComment } from './fix-presentation.js';
import { labelledLines } from './fix-terminal.js';
import { groupByReason } from './reason-groups.js';
import { formatHandoff, fixInstructions } from './fix-handoff.js';
import { attachRecipeFixes } from './fix-recipes.js';
import { recordBulk } from './fix-history.js';
import { writeReviewHandoff } from './review-delivery.js';
import { hunkRange, writeFixes } from './fix-convergence.js';

interface BulkFixOptions {
  includeReview?: boolean;
  format?: boolean;
  verifyTypes?: boolean;
  dryRun?: boolean;
}

function hasFix(finding: Finding): finding is FixableFinding {
  return Boolean(finding.fix);
}

const usage = `Usage: loadwise fix (--yes | --all | --handoff) [checkers...]
  --yes    Apply automatic fixes.
  --all    Apply every generated fix, including edits marked for individual review.
  --dry-run      Preview converged unified diffs without writing files.
  --rule <id>    Limit fixes to the named rule ID (repeatable).
  --handoff  Print a read-only Markdown brief for manual findings.
  --review   With --yes or --all, save this run and print a handoff for any coding agent.
  --json   With --yes or --all, print the applied hunks, manual findings and pending review findings as JSON.
  --recipe <name|file.cjs>  With --all, use verified-private-types or a trusted local fix recipe.
  --only   Select checkers by name. Spaces or commas separate multiple names.
  --no-verify-types  Skip Layer-2 semantic type-check verification on modified TS files.
  --no-comments  Do not add the "// Loadwise <rule-id>: <why>" comment above each fixed statement.
  --no-format    Do not format the changed lines with the project's Prettier.
  Checkers: performance (perf), maintainability (maint), security (sec).
  Omit checker names to use the project's configured checkers.

  loadwise fix --all
  loadwise fix --yes performance
  loadwise fix --all --only perf,sec`;

function fixOptions(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      yes: { type: 'boolean' },
      all: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      rule: { type: 'string', multiple: true },
      handoff: { type: 'boolean' },
      review: { type: 'boolean' },
      json: { type: 'boolean' },
      only: { type: 'string', multiple: true },
      recipe: { type: 'string' },
      comments: { type: 'boolean' },
      'no-comments': { type: 'boolean' },
      'no-format': { type: 'boolean' },
      'no-verify-types': { type: 'boolean' },
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
  const selected = new Set<string>();
  for (const list of [...(values.only ?? []), ...positionals]) {
    for (const item of list.split(',')) {
      const selector = item.trim();
      const checker = pillars.find(({ name, jsonKey }) => name === selector || jsonKey === selector);
      if (!checker) throw new Error(`Invalid checker "${selector}". Choose performance, maintainability, or security.`);
      selected.add(checker.name);
    }
  }
  const rules = (values.rule ?? [])
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    includeReview: Boolean(values.all),
    dryRun: Boolean(values['dry-run']),
    rules: rules.length ? new Set(rules) : undefined,
    handoff: Boolean(values.handoff),
    requestReview: Boolean(values.review),
    json: Boolean(values.json),
    recipe: values.recipe,
    comments: !values['no-comments'],
    format: !values['no-format'],
    verifyTypes: !values['no-verify-types'],
    selected: selected.size ? [...selected] : undefined,
  };
}

function location(finding: Finding): string {
  return `${finding.checker} ${finding.file}:${finding.line} [${finding.ruleId} #${finding.id}]`;
}

function printFixed(applied: readonly FixableFinding[]): void {
  const printNote = (finding: FixableFinding, indentation: string): void => {
    if (!finding.fix.note) return;
    for (const line of labelledLines('Note', finding.fix.note, indentation)) console.log(line);
  };
  const printWhy = (why: string | undefined): void => {
    if (why) for (const line of labelledLines('Why', why)) console.log(line);
  };
  for (const group of groupByReason(applied, (finding) => finding.ruleId)) {
    const [first] = group;
    const why = ruleWhy(first.ruleId);
    if (group.length === 1) {
      console.log('Fixed: ' + location(first));
      printWhy(why);
      printNote(first, '  ');
      continue;
    }
    console.log(`Fixed ${group.length} [${first.ruleId}]:`);
    printWhy(why);
    for (const finding of group) {
      console.log(`  ${finding.checker} ${finding.file}:${finding.line} #${finding.id}`);
      printNote(finding, '    ');
    }
  }
}

function applyBulkFixes(
  findings: Finding[],
  directory: string,
  { includeReview = false, format = false, verifyTypes = true, dryRun = false }: BulkFixOptions = {},
) {
  const reviewedRanges = new Map<string, [number, number][]>();
  const target = (change: FixChange) => {
    const file = realTarget(path.resolve(directory, change.file));
    return process.platform === 'win32' ? file.toLowerCase() : file;
  };
  for (const finding of findings) {
    if (!finding.fix?.requiresReview) continue;
    for (const change of finding.fix.changes) {
      const file = target(change);
      const ranges = reviewedRanges.get(file) ?? [];
      reviewedRanges.set(file, ranges);
      ranges.push(hunkRange(change));
    }
  }
  const automatic: FixableFinding[] = [];
  const manual: Finding[] = [];
  const review: FixableFinding[] = [];
  function touchesReviewedLines(change: FixChange): boolean {
    if (!reviewedRanges.size) return false;
    const [first, last] = hunkRange(change);
    return reviewedRanges.get(target(change))?.some(([start, end]) => first <= end && start <= last) ?? false;
  }
  for (const finding of findings) {
    if (!hasFix(finding)) manual.push(finding);
    else if (finding.fix.requiresReview || finding.fix.changes.some(touchesReviewedLines)) review.push(finding);
    else automatic.push(finding);
  }
  const written = writeFixes(includeReview ? [...automatic, ...review] : automatic, directory, {
    format,
    verifyTypes,
    dryRun,
  });
  return { automatic, manual, review, ...written };
}

async function attachRecipe(scanned: Finding[], recipe: string | undefined): Promise<Finding[]> {
  if (recipe === 'verified-private-types') {
    const { attachVerifiedPrivateTypes } = await import('../maintainability/verified-private-types.js');
    return await attachVerifiedPrivateTypes(scanned, process.cwd());
  }
  if (recipe) return await attachRecipeFixes(scanned, recipe, process.cwd());
  return scanned;
}

function withoutFixComment(finding: Finding): Finding {
  return finding.fix ? { ...finding, fix: withoutWhyComment(finding.fix, finding.ruleId) } : finding;
}

interface FixCounts {
  applied: number;
  changedFiles: number;
  manual: number;
  review: number;
}

function fixSummary(includeReview: boolean, { applied, changedFiles, manual, review }: FixCounts): string {
  return includeReview
    ? `${applied} generated fix(es) in ${changedFiles} file(s), ${manual} manual, ${review} review-marked fix(es) applied.`
    : `${applied} automatic fix(es) in ${changedFiles} file(s), ${manual} manual, ${review} requiring individual review.`;
}

function printDryRunDiff(updates: readonly FileUpdate[], directory: string): void {
  for (const { file, before, after } of updates) {
    const rel = path.relative(directory, file).split(path.sep).join('/');
    console.log(`--- a/${rel}`);
    console.log(`+++ b/${rel}`);
    for (const line of (before ?? '').split('\n')) console.log(`-${line}`);
    for (const line of after.split('\n')) console.log(`+${line}`);
  }
}

async function runFix(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(usage);
    return 0;
  }
  const {
    selected,
    includeReview,
    dryRun,
    rules,
    recipe,
    handoff,
    json,
    requestReview,
    comments,
    format,
    verifyTypes,
  } = fixOptions(args);
  const scannedAll = await scanForFixes(selected);
  const scanned = rules ? scannedAll.filter((finding) => rules.has(finding.ruleId)) : scannedAll;
  if (handoff) {
    console.log(formatHandoff(scanned, selected));
    return 0;
  }
  const withRecipe = await attachRecipe(scanned, recipe);
  const findings = comments ? withRecipe : withRecipe.map(withoutFixComment);
  const { applied, manual, review, refused, changedFiles, updates } = applyBulkFixes(findings, process.cwd(), {
    includeReview,
    format,
    verifyTypes,
    dryRun,
  });
  const pendingReview = includeReview ? [] : review;
  if (changedFiles && !dryRun)
    recordBulk(process.cwd(), {
      applied,
      manual,
      pendingReview,
    });
  const instructions = fixInstructions(findings.length, selected, manual.length);
  const notApplied = refused.map(({ finding, reason }) => ({ id: finding.id, ruleId: finding.ruleId, reason }));
  const report = { changedFiles, dryRun, applied, manual, pendingReview, notApplied, instructions };
  if (requestReview && !dryRun)
    await writeReviewHandoff(process.cwd(), 'fix', {
      args,
      format: 'json',
      report,
      exitCode: 0,
    });
  if (json) {
    console.log(JSON.stringify(report));
    return 0;
  }
  if (dryRun && updates.length) printDryRunDiff(updates, process.cwd());
  if (!includeReview) for (const finding of review) console.log('Review individually: ' + location(finding));
  for (const finding of manual) console.log('Manual change: ' + location(finding));
  for (const { finding, reason } of refused) console.log(`Not applied: ${location(finding)}: ${reason}`);
  printFixed(applied);
  console.log(
    fixSummary(includeReview, {
      applied: applied.length,
      changedFiles,
      manual: manual.length,
      review: review.length,
    }),
  );
  console.log(instructions);
  return 0;
}

export { runFix, applyBulkFixes, realTarget };
