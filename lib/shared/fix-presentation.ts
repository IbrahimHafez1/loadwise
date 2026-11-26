// How an applied fix reads in the project: a one-line comment above the fixed statement says why it changed, and the
// project's own Prettier reformats only the changed lines. Prettier's API is asynchronous while the fix paths are
// not, so formatting runs once per fix run in a child process started from this file.
import fs, { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as ts from 'typescript';
import * as maintainabilityRuleIds from '../maintainability/rule-ids.js';
import * as performanceRuleIds from '../performance/rule-ids.js';
import { descriptionByRule } from '../security/rule-descriptions.js';
import { impactByRule as impactByRuleRuleIds } from '../security/rule-ids.js';
import { writeFileAtomic } from './atomic-write.js';
import { createWhyCommentTools, formatComment, withoutComment } from './fix-presentation-comments.js';
import { formatInChild, formatRanges, missingPrettierNote, scriptFile } from './fix-presentation-prettier.js';
import {
  bottomFirst,
  followSteps,
  ownedHunks,
  rangesOf,
  replaceRows,
  segmentsOf,
  splitRows,
  styleRegions,
} from './fix-presentation-rows.js';
import { matchFileStyle } from './fix-presentation-style.js';
import type { FindingFix, FixChange } from './types.js';
import type {
  FormatFile,
  FormatRequest,
  Owner,
  PrettierApi,
  RowSegment,
  RuleDescriptions,
  TypeScript,
  WriteTracker,
  WrittenChange,
} from './types/fix-presentation.js';
import type { FormattedHunk, FormattedUpdates, HunkedFileUpdate } from './types/fix-run.js';

const checkers: RuleDescriptions[] = [
  performanceRuleIds,
  maintainabilityRuleIds,
  {
    impactByRule: impactByRuleRuleIds,
    descriptionByRule: descriptionByRule,
  },
];

function checkerFor(ruleId: string): RuleDescriptions | undefined {
  return checkers.find(({ impactByRule }) => Object.hasOwn(impactByRule, ruleId));
}

function loadTs(): TypeScript {
  return ts;
}

const loadProjectModule = createRequire(import.meta.url);

// The project's own Prettier: the nearest `node_modules/prettier` at or above `folder`. A global
// install, such as one on NODE_PATH, is not the project's formatter.
function projectPrettier(folder: string): PrettierApi | undefined {
  for (let directory = folder; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', 'prettier');
    if (existsSync(path.join(candidate, 'package.json'))) {
      try {
        const prettier: PrettierApi = loadProjectModule(candidate);
        return prettier;
      } catch {
        return undefined;
      }
    }
    if (path.dirname(directory) === directory) return undefined;
  }
}

// `--no-comments` and `--no-format` as fix options. `--comments` is still accepted for scripts
// written while why-comments were opt-in.
const fixPresentation = (values: {
  'no-comments'?: boolean;
  'no-format'?: boolean;
}): { comments: boolean; format: boolean } => ({
  comments: !values['no-comments'],
  format: !values['no-format'],
});

const { ruleWhy, whyComment, withWhyComment, rememberCommentRow, dropConflictingComments, withoutWhyComment } =
  createWhyCommentTools({ checkerFor, loadTs });

// Formats the changed rows of written fixes. `updates` are `{ file, before, after, hunks }`, where
// each hunk is `{ key, row, removed, added }` in rows of `before` (a created file has `before`
// undefined). Returns the formatted text by file and, by hunk key, each change as it reads in that
// text: `{ line, before, after }`.
function formatUpdates(root: string, updates: readonly HunkedFileUpdate[]): FormattedUpdates {
  const files: FormatFile[] = [];
  const segmentsByFile = new Map<string, RowSegment[]>();
  for (const update of updates) {
    if (!scriptFile.test(update.file)) continue;
    const originalRows = update.before === undefined ? 0 : splitRows(update.before).length;
    const segments = segmentsOf(originalRows, update.hunks);
    segmentsByFile.set(update.file, segments);
    const ranges = bottomFirst(rangesOf(segments));
    files.push({
      file: update.file,
      text: update.after,
      ranges: ranges.map(({ start, end }): [number, number] => [start, end]),
    });
  }
  const stepsByFile = formatRanges(import.meta.filename, root, files);
  const texts = new Map<string, string>();
  const hunks = new Map<string, FormattedHunk>();
  for (const update of updates) {
    if (!segmentsByFile.has(update.file)) continue;
    const steps = stepsByFile?.get(update.file);
    const originalRows = update.before === undefined ? [] : splitRows(update.before);
    let segments = segmentsByFile.get(update.file) ?? [];
    let formattedText: string;
    if (steps?.length) {
      formattedText = steps.at(-1) ?? update.after;
      segments = followSteps(segments, update.after, steps);
    } else {
      const regions = styleRegions(segments, (segment: RowSegment, originalRow: number) =>
        originalRows.slice(originalRow, originalRow + segment.originalLength),
      );
      formattedText = matchFileStyle(loadTs, update.file, update.after, regions);
    }
    if (formattedText === update.after) continue;
    texts.set(update.file, formattedText);
    for (const [key, hunk] of ownedHunks(segments, originalRows, splitRows(formattedText))) {
      if (typeof key === 'string') hunks.set(key, hunk);
    }
  }
  return { texts, hunks };
}

// For the per-checker `--fix`, which writes each fix as it is accepted. Records the rows each write
// changed, so a later fix from the same scan is moved to where its lines are now, and the changed
// rows are formatted once the run ends. Each recorded change's `owner`, such as its fix-history
// entry, then gets the `after` text that was written.
function createWriteTracker(): WriteTracker {
  const segmentsByFile = new Map<string, RowSegment[]>();
  const writesByFile = new Map<string, { row: number; removed: number; delta: number }[]>();
  const beforeRowsByOwner = new Map<Owner, string[]>();
  function record(file: string, { line, before, after, create, owner }: WrittenChange): void {
    const added = splitRows(after).length;
    beforeRowsByOwner.set(owner, [...(beforeRowsByOwner.get(owner) ?? []), ...(create ? [] : splitRows(before))]);
    if (create) {
      segmentsByFile.set(file, [{ length: added, originalLength: 0, owners: new Set([owner]) }]);
      return;
    }
    const row = line - 1;
    const removed = splitRows(before).length;
    const writes = writesByFile.get(file) ?? [];
    writesByFile.set(file, writes);
    writes.push({ row, removed, delta: added - removed });
    const region = { first: row, beforeEnd: row + removed, afterEnd: row + added };
    // The rows after the last write are never counted, so the file starts as one open-ended
    // unchanged run.
    const segments: readonly RowSegment[] = segmentsByFile.get(file) ?? [
      { length: Infinity, originalLength: Infinity },
    ];
    segmentsByFile.set(file, replaceRows(segments, region, [owner]));
  }
  return {
    // The changes of one write, `{ file, line, before, after, create, owner }` in the rows each
    // file had before it, after that write. They are recorded bottom first so the rows of the rest
    // still hold.
    recordWrites(changes: readonly WrittenChange[]): void {
      for (const change of [...changes].sort((left, right) => right.line - left.line)) record(change.file, change);
    },
    // The fix with each change's line moved past the rows earlier writes added or removed above it.
    // `absolute` maps a change's file to the path its writes were recorded under.
    rebase(fix: FindingFix, absolute: (file: string) => string): FindingFix {
      const changes = fix.changes.map((change: FixChange) => {
        if (change.create) return change;
        let row = change.line - 1;
        for (const write of writesByFile.get(absolute(change.file)) ?? []) {
          if (write.row + write.removed <= row) row += write.delta;
        }
        return row === change.line - 1 ? change : { ...change, line: row + 1 };
      });
      return { ...fix, changes };
    },
    format(root: string): void {
      const files = [...segmentsByFile].map(([file, segments]) => ({
        file,
        segments,
        text: fs.readFileSync(file, 'utf8'),
        ranges: bottomFirst(rangesOf(segments)).map(({ start, end }): [number, number] => [start, end]),
      }));
      const stepsByFile = formatRanges(
        import.meta.filename,
        root,
        files.map(({ file, text, ranges }) => ({ file, text, ranges })),
      );
      for (const { file, segments, text } of files) {
        const steps = stepsByFile?.get(file);
        const beforeRowsOf = (segment: RowSegment): string[] =>
          [...(segment.owners ?? [])].flatMap((owner: Owner) => beforeRowsByOwner.get(owner) ?? []);
        const formattedText = steps?.length
          ? (steps.at(-1) ?? text)
          : matchFileStyle(loadTs, file, text, styleRegions(segments, beforeRowsOf));
        if (formattedText === text) continue;
        if (fs.readFileSync(file, 'utf8') !== text) continue;
        writeFileAtomic(file, formattedText);
        const formatted = ownedHunks(
          steps?.length ? followSteps(segments, text, steps) : segments,
          [],
          splitRows(formattedText),
        );
        for (const [owner, hunk] of formatted) if (typeof owner === 'object') owner.after = hunk.after;
      }
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const input: FormatRequest = JSON.parse(readFileSync(0, 'utf8'));
  formatInChild(input, { projectPrettier, loadTs }).then((output) => process.stdout.write(JSON.stringify(output)));
}

export {
  createWriteTracker,
  dropConflictingComments,
  fixPresentation,
  formatComment,
  formatUpdates,
  missingPrettierNote,
  rememberCommentRow,
  ruleWhy,
  whyComment,
  withWhyComment,
  withoutComment,
  withoutWhyComment,
};
