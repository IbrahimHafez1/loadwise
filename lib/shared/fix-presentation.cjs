// @ts-check
'use strict';

// How an applied fix reads in the project: a one-line comment above the fixed statement says why it changed, and the
// project's own Prettier reformats only the changed lines. Prettier's API is asynchronous while the fix paths are
// not, so formatting runs once per fix run in a child process started from this file.
const path = require('node:path');
const { findLineIndex } = require('../performance/sql/locations.cjs');
const { fixRationaleByRule } = require('./fix-rationales.cjs');
const { writeFileAtomic } = require('./atomic-write.cjs');

const missingPrettierNote = 'Install prettier in the project to format applied fixes.';
const scriptFile = /\.[cm]?[jt]sx?$/i;
// Generous: a run formats every changed range of every touched file in one process.
const formatTimeoutMs = 120_000;
const formatOutputLimit = 1 << 30;
// Comparing larger reformatted regions line by line costs more than formatting is worth.
const maxDiffCells = 4_000_000;

let checkers;
function checkerFor(ruleId) {
  checkers ??= [
    require('../performance/rule-ids.cjs'),
    require('../maintainability/rule-ids.cjs'),
    {
      impactByRule: require('../security/rule-ids.cjs').impactByRule,
      descriptionByRule: require('../security/rule-descriptions.cjs').descriptionByRule,
    },
  ];
  return checkers.find(({ impactByRule }) => Object.hasOwn(impactByRule, ruleId));
}

// `--no-comments` and `--no-format` as fix options. `--comments` is still accepted for scripts written while
// why-comments were opt-in.
const fixPresentation = (values) => ({ comments: !values['no-comments'], format: !values['no-format'] });

function firstSentence(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return /^.+?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
}

// Why a fix for the rule changed the code: its fix rationale, which describes the code after the fix, or else the
// first sentence of the rule's description. Both are site-neutral, unlike the example note, which names the
// example's variables rather than the fixed code's.
function ruleWhy(ruleId) {
  if (Object.hasOwn(fixRationaleByRule, ruleId)) return fixRationaleByRule[ruleId];
  return firstSentence(checkerFor(ruleId)?.descriptionByRule[ruleId] ?? '') || undefined;
}

// Prettier leaves comments as written, so the why-comment is wrapped here to stay readable beside the code.
const commentLineWidth = 80;
const commentByRule = new Map();
// `text` as `//` lines, joined by `\n`, the first starting `// Loadwise <rule-id>:`.
function formatComment(ruleId, text) {
  const { wrapWords } = require('./fix-terminal.cjs');
  return wrapWords(`Loadwise ${ruleId}: ${text}`, commentLineWidth - '// '.length)
    .map((line) => '// ' + line)
    .join('\n');
}

// The rule's why as a comment, the same for every fix of the rule.
function whyComment(ruleId) {
  if (commentByRule.has(ruleId)) return commentByRule.get(ruleId);
  const why = ruleWhy(ruleId);
  const comment = why ? formatComment(ruleId, why) : undefined;
  // loadwise-reviewed unbounded-module-cache -- The keys are rule ids, a fixed set shipped with Loadwise, so the cache cannot grow past it.
  commentByRule.set(ruleId, comment);
  return comment;
}

const templateOrJsx = (ts, node) =>
  ts.isTemplateExpression(node) ||
  ts.isTaggedTemplateExpression(node) ||
  ts.isJsxElement(node) ||
  ts.isJsxFragment(node) ||
  ts.isJsxSelfClosingElement(node);

// The statement, class member or interface member that holds the node. Undefined inside a template or JSX, and in
// a catch block, where any comment counts as handling the error.
function holdingStatement(ts, node) {
  let statement = node;
  while (statement && !ts.isSourceFile(statement)) {
    const parent = statement.parent;
    if (
      ts.isSourceFile(parent) ||
      ts.isBlock(parent) ||
      ts.isModuleBlock(parent) ||
      ts.isCaseClause(parent) ||
      ts.isDefaultClause(parent) ||
      (ts.isClassElement(statement) && ts.isClassLike(parent)) ||
      (ts.isTypeElement(statement) && ts.isInterfaceDeclaration(parent))
    )
      break;
    statement = parent;
  }
  if (!statement || ts.isSourceFile(statement)) return;
  if (ts.isBlock(statement.parent) && ts.isCatchClause(statement.parent.parent)) return;
  for (let ancestor = statement.parent; ancestor; ancestor = ancestor.parent) {
    if (templateOrJsx(ts, ancestor)) return;
  }
  return statement;
}

const containers = (ts, node) =>
  ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node) || ts.isClassLike(node);

// Statements that hold the fixed site, most direct first: the finding's own statement when the fix edits it, then
// the statement at each edit nearest the finding. An edit that only deletes, or starts between statements, holds none.
function candidateStatements(ts, entry, edits, findingOffset) {
  const { sourceFile, text } = entry;
  const { innermostNodeAt } = require('./fix-hunks.cjs');
  const candidates = [];
  const findingStatement = holdingStatement(ts, innermostNodeAt(ts, sourceFile, findingOffset));
  const touches = (edit, node) => edit.start <= node.end && edit.end >= node.getStart(sourceFile);
  if (findingStatement && edits.some((edit) => touches(edit, findingStatement))) candidates.push(findingStatement);
  const distance = (edit) => Math.max(0, edit.start - findingOffset, findingOffset - edit.end);
  for (const edit of [...edits].sort((left, right) => distance(left) - distance(right))) {
    if (!edit.text) continue;
    const codeStart = edit.start + /^\s*/.exec(text.slice(edit.start, Math.max(edit.start, edit.end)))[0].length;
    const node = innermostNodeAt(ts, sourceFile, codeStart);
    if (!node || containers(ts, node)) continue;
    const statement = holdingStatement(ts, node);
    if (statement && !candidates.includes(statement)) candidates.push(statement);
  }
  return candidates;
}

// Standalone comments directly above a statement (a review directive, JSDoc, eslint-disable-next-line) stay attached
// to it, so the why-comment goes above them. Returns the first row of that block, or `present` when it already holds
// this rule's comment.
function commentBlockTop(ts, entry, statement, row, comment) {
  const { text, lineStarts } = entry;
  const rulePrefix = comment.slice(0, comment.indexOf(':') + 1);
  let top = row;
  for (const range of [...(ts.getLeadingCommentRanges(text, statement.pos) ?? [])].reverse()) {
    const firstRow = findLineIndex(lineStarts, range.pos);
    if (findLineIndex(lineStarts, range.end - 1) !== top - 1 || /\S/.test(text.slice(lineStarts[firstRow], range.pos)))
      break;
    if (text.slice(range.pos, range.end).startsWith(rulePrefix)) return 'present';
    top = firstRow;
  }
  return top;
}

// The edits with the comment line inserted above the statement and the row it goes above, `present` when the comment
// is already there, or undefined when the statement has no line of its own or an edit spans the insertion point.
function commentedEdits(ts, entry, edits, statement, { comment, separateEdits }) {
  const { text, lineStarts } = entry;
  const start = statement.getStart(entry.sourceFile);
  const row = findLineIndex(lineStarts, start);
  const indentation = text.slice(lineStarts[row], start);
  // Code before the statement on its line, such as `} else {`, leaves no line of its own to comment.
  if (/\S/.test(indentation)) return;
  const top = commentBlockTop(ts, entry, statement, row, comment);
  if (top === 'present') return top;
  const offset = lineStarts[top];
  const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
  const line = comment
    .split('\n')
    .map((commentLine) => indentation + commentLine + lineBreak)
    .join('');
  if (edits.some((edit) => edit.start < offset && offset < edit.end)) return;
  const atOffset = edits.filter((edit) => edit.start === offset);
  if (!atOffset.length)
    return { edits: [...edits, { start: offset, end: offset, text: line, comment: true }], row: top };
  // A shared insertion must stay identical across the fixes that make it, so it takes no comment.
  if (atOffset.length > 1 || (separateEdits && atOffset[0].end === offset)) return;
  return {
    edits: edits.map((edit) => (edit === atOffset[0] ? { ...edit, text: line + edit.text } : edit)),
    row: top,
  };
}

// Adds the rule's why-comment above the statement holding the primary fixed site. Returns the edits unchanged and no
// comment when the comment is already there or there is no safe place for it.
function withWhyComment({ ruleId, entry, edits, findingOffset, separateEdits = false }) {
  const comment = whyComment(ruleId);
  if (!comment || !entry?.sourceFile || !edits?.length) return { edits };
  const ts = require('typescript');
  for (const statement of candidateStatements(ts, entry, edits, findingOffset)) {
    const commented = commentedEdits(ts, entry, edits, statement, { comment, separateEdits });
    if (commented === 'present') break;
    if (commented) return { ...commented, comment };
  }
  return { edits };
}

// The file and original row each built fix's why-comment goes above, so fixes that share it can be found.
const commentAnchors = new WeakMap();
function rememberCommentRow(fix, file, row) {
  commentAnchors.set(fix, { file, row });
}

// Fixes are built one finding at a time, but applied together. When a fix's comment would go above a row that an
// earlier fix already comments with a different change, or whose code another fix changes differently, applying both
// would overlap, so the later fix keeps its edits without the comment. Identical commented changes stay, as they
// apply once.
function dropConflictingComments(findings) {
  const changedRows = new Map();
  for (const finding of findings) {
    if (!finding.fix) continue;
    for (const change of withoutWhyComment(finding.fix, finding.ruleId).changes) {
      if (change.create) continue;
      if (!changedRows.has(change.file)) changedRows.set(change.file, []);
      const key = JSON.stringify(change);
      changedRows
        .get(change.file)
        .push({ finding, key, start: change.line - 1, end: change.line - 1 + splitRows(change.before).length });
    }
  }
  const commentedChanges = new Map();
  for (const finding of findings) {
    const anchor = finding.fix && commentAnchors.get(finding.fix);
    if (!anchor) continue;
    const comment = finding.fix.comment ?? whyComment(finding.ruleId);
    const withComment = finding.fix.changes
      .filter((change) => withoutComment(change.after, comment) !== change.after)
      .map((change) => JSON.stringify(change));
    const own = new Set(withoutWhyComment(finding.fix, finding.ruleId).changes.map((change) => JSON.stringify(change)));
    const overlapsOther = (changedRows.get(anchor.file) ?? []).some(
      (range) =>
        range.finding !== finding && !own.has(range.key) && range.start <= anchor.row && anchor.row < range.end,
    );
    const anchorKey = anchor.file + '\0' + anchor.row;
    const earlier = commentedChanges.get(anchorKey);
    if (overlapsOther || (earlier && !withComment.every((change) => earlier.has(change))))
      finding.fix = withoutWhyComment(finding.fix, finding.ruleId);
    else if (!earlier) commentedChanges.set(anchorKey, new Set(withComment));
  }
}

// The hunk's text without the why-comment, for limits that measure the code. Only a whole run of the comment's lines
// is removed, so a project comment that matches one wrapped line stays.
function withoutComment(text, comment) {
  if (!comment) return text;
  const commentLines = comment.split('\n');
  const lines = text.split('\n');
  const kept = [];
  for (let index = 0; index < lines.length; index++) {
    const isComment = commentLines.every((commentLine, offset) => lines[index + offset]?.trim() === commentLine);
    if (isComment) index += commentLines.length - 1;
    else kept.push(lines[index]);
  }
  return kept.join('\n');
}

// `--no-comments`: the fix as it would be built without its why-comment. A fix that wrote its own comment for
// this site, such as naming the index it removed, carries that text as `fix.comment`.
function withoutWhyComment(fix, ruleId) {
  const comment = fix?.comment ?? whyComment(ruleId);
  if (!fix || !comment) return fix;
  const changes = [];
  for (const change of fix.changes) {
    if (change.create || withoutComment(change.before, comment) !== change.before) changes.push(change);
    else {
      const after = withoutComment(change.after, comment);
      if (after !== change.before) changes.push({ ...change, after });
    }
  }
  return { ...fix, changes };
}

function splitRows(text) {
  return text.split('\n');
}

// Formats row ranges `[start, end)` of each file with the Prettier its folder resolves. Returns a map from file to
// the text after each range, bottom range first, or undefined when no file could load Prettier.
function formatRanges(root, files) {
  const scripts = files.filter(({ file, ranges }) => scriptFile.test(file) && ranges.length);
  if (!scripts.length) return new Map();
  const { spawnSync } = require('node:child_process');
  const child = spawnSync(process.execPath, [__filename], {
    input: JSON.stringify({ root, files: scripts }),
    encoding: 'utf8',
    maxBuffer: formatOutputLimit,
    timeout: formatTimeoutMs,
    windowsHide: true,
  });
  let output;
  try {
    output = JSON.parse(child.stdout);
  } catch {
    console.error('Could not format applied fixes: ' + (child.error?.message ?? child.stderr.trim()));
    return new Map();
  }
  if (output.missing) {
    console.error(missingPrettierNote);
    return;
  }
  return new Map(output.results.map(({ file, steps }) => [file, steps]));
}

// Merges overlapping or touching ranges and orders them bottom first, so formatting one leaves the rows of the next
// unchanged.
function bottomFirst(ranges) {
  const merged = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      for (const owner of range.owners ?? []) last.owners.add(owner);
    } else merged.push({ start: range.start, end: range.end, owners: new Set(range.owners) });
  }
  return merged.reverse();
}

// Lines that differ between two texts: `[first, beforeEnd)` of `before` became `[first, afterEnd)` of `after`.
function changedRows(beforeRows, afterRows) {
  let first = 0;
  while (first < beforeRows.length && first < afterRows.length && beforeRows[first] === afterRows[first]) first++;
  let same = 0;
  while (
    same < beforeRows.length - first &&
    same < afterRows.length - first &&
    beforeRows[beforeRows.length - 1 - same] === afterRows[afterRows.length - 1 - same]
  )
    same++;
  return { first, beforeEnd: beforeRows.length - same, afterEnd: afterRows.length - same };
}

// Tracks which rows of a file each applied change owns while Prettier rewrites them. A segment is a run of rows:
// unchanged original rows, or rows written by changes (`owners`) that replaced `originalLength` original rows.
function segmentsOf(originalRowCount, hunks) {
  const segments = [];
  let cursor = 0;
  for (const hunk of [...hunks].sort((left, right) => left.row - right.row)) {
    if (hunk.row > cursor) segments.push({ length: hunk.row - cursor, originalLength: hunk.row - cursor });
    segments.push({ length: hunk.added, originalLength: hunk.removed, owners: new Set([hunk.key]) });
    cursor = hunk.row + hunk.removed;
  }
  if (originalRowCount > cursor)
    segments.push({ length: originalRowCount - cursor, originalLength: originalRowCount - cursor });
  return segments;
}

function rangesOf(segments) {
  const ranges = [];
  let row = 0;
  for (const segment of segments) {
    if (segment.owners) ranges.push({ start: row, end: row + segment.length, owners: segment.owners });
    row += segment.length;
  }
  return ranges;
}

// Replaces the segments under rows `[first, end)` with the formatted rows, widened to whole changed segments.
function replaceRows(segments, { first, beforeEnd, afterEnd }, owners) {
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  // An empty region (Prettier only inserted rows) belongs to the row it was inserted at, or the last row.
  const coverStart = beforeEnd > first ? first : Math.max(0, Math.min(first, total - 1));
  const coverEnd = beforeEnd > first ? beforeEnd : coverStart + 1;
  const before = [];
  const covered = [];
  const after = [];
  let row = 0;
  const side = (start, end) => (end <= coverStart ? before : start >= coverEnd ? after : covered);
  for (const segment of segments) {
    const segmentEnd = row + segment.length;
    // Rows a change wrote stay whole; unchanged rows split at the region's edges.
    if (segment.owners) side(row, segmentEnd).push(segment);
    else {
      let from = row;
      for (const cut of [coverStart, coverEnd, segmentEnd].filter((cut) => cut > row && cut <= segmentEnd)) {
        if (cut <= from) continue;
        side(from, cut).push({ length: cut - from, originalLength: cut - from });
        from = cut;
      }
    }
    row = segmentEnd;
  }
  if (!covered.length) return segments;
  const merged = {
    length: covered.reduce((sum, segment) => sum + segment.length, 0) + (afterEnd - beforeEnd),
    originalLength: covered.reduce((sum, segment) => sum + segment.originalLength, 0),
    owners: new Set([...owners, ...covered.flatMap((segment) => [...(segment.owners ?? [])])]),
  };
  return [...before, merged, ...after];
}

const plainRows = (rows) => rows.map((row) => row.replace(/\r$/, '')).join('\n');

// Each owner's change as it reads in the formatted file: its original rows and the rows that replaced them.
function ownedHunks(segments, originalRows, formattedRows) {
  const hunks = new Map();
  let row = 0;
  let originalRow = 0;
  for (const segment of segments) {
    for (const owner of segment.owners ?? []) {
      const hunk = hunks.get(owner);
      if (!hunk) hunks.set(owner, { row, originalRow, end: row, originalEnd: originalRow });
    }
    row += segment.length;
    originalRow += segment.originalLength;
    for (const owner of segment.owners ?? []) Object.assign(hunks.get(owner), { end: row, originalEnd: originalRow });
  }
  return new Map(
    [...hunks].map(([owner, hunk]) => [
      owner,
      {
        line: hunk.originalRow + 1,
        before: plainRows(originalRows.slice(hunk.originalRow, hunk.originalEnd)),
        after: plainRows(formattedRows.slice(hunk.row, hunk.end)),
      },
    ]),
  );
}

// The segments after each formatting step, where step `index` formatted range `index` of `bottomFirst` order.
function followSteps(segments, text, steps) {
  const ranges = bottomFirst(rangesOf(segments));
  let previous = splitRows(text);
  steps.forEach((stepText, index) => {
    const next = splitRows(stepText);
    const region = changedRows(previous, next);
    if (region.first < previous.length || previous.length !== next.length)
      segments = replaceRows(segments, region, ranges[index].owners);
    previous = next;
  });
  return segments;
}

// Formats the changed rows of written fixes. `updates` are `{ file, before, after, hunks }`, where each hunk is
// `{ key, row, removed, added }` in rows of `before` (a created file has `before` undefined). Returns the formatted
// text by file and, by hunk key, each change as it reads in that text: `{ line, before, after }`.
function formatUpdates(root, updates) {
  const files = [];
  const segmentsByFile = new Map();
  for (const update of updates) {
    if (!scriptFile.test(update.file)) continue;
    const originalRows = update.before === undefined ? 0 : splitRows(update.before).length;
    const segments = segmentsOf(originalRows, update.hunks);
    segmentsByFile.set(update.file, segments);
    const ranges = bottomFirst(rangesOf(segments));
    files.push({ file: update.file, text: update.after, ranges: ranges.map(({ start, end }) => [start, end]) });
  }
  const stepsByFile = formatRanges(root, files);
  const texts = new Map();
  const hunks = new Map();
  for (const update of updates) {
    if (!segmentsByFile.has(update.file)) continue;
    const steps = stepsByFile?.get(update.file);
    const originalRows = update.before === undefined ? [] : splitRows(update.before);
    let segments = segmentsByFile.get(update.file);
    let formattedText;
    if (steps?.length) {
      formattedText = steps.at(-1);
      segments = followSteps(segments, update.after, steps);
    } else {
      const regions = styleRegions(segments, (segment, originalRow) =>
        originalRows.slice(originalRow, originalRow + segment.originalLength),
      );
      formattedText = matchFileStyle(update.file, update.after, regions);
    }
    if (formattedText === update.after) continue;
    texts.set(update.file, formattedText);
    for (const [key, hunk] of ownedHunks(segments, originalRows, splitRows(formattedText))) hunks.set(key, hunk);
  }
  return { texts, hunks };
}

// For the per-checker `--fix`, which writes each fix as it is accepted. Records the rows each write changed, so a
// later fix from the same scan is moved to where its lines are now, and the changed rows are formatted once the run
// ends. Each recorded change's `owner`, such as its fix-history entry, then gets the `after` text that was written.
function createWriteTracker() {
  const segmentsByFile = new Map();
  const writesByFile = new Map();
  const beforeRowsByOwner = new Map();
  function record(file, { line, before, after, create, owner }) {
    const added = splitRows(after).length;
    beforeRowsByOwner.set(owner, [...(beforeRowsByOwner.get(owner) ?? []), ...(create ? [] : splitRows(before))]);
    if (create) {
      segmentsByFile.set(file, [{ length: added, originalLength: 0, owners: new Set([owner]) }]);
      return;
    }
    const row = line - 1;
    const removed = splitRows(before).length;
    if (!writesByFile.has(file)) writesByFile.set(file, []);
    writesByFile.get(file).push({ row, removed, delta: added - removed });
    const region = { first: row, beforeEnd: row + removed, afterEnd: row + added };
    // The rows after the last write are never counted, so the file starts as one open-ended unchanged run.
    const segments = segmentsByFile.get(file) ?? [{ length: Infinity, originalLength: Infinity }];
    segmentsByFile.set(file, replaceRows(segments, region, [owner]));
  }
  return {
    // The changes of one write, `{ file, line, before, after, create, owner }` in the rows each file had before it,
    // after that write. They are recorded bottom first so the rows of the rest still hold.
    recordWrites(changes) {
      for (const change of [...changes].sort((left, right) => right.line - left.line)) record(change.file, change);
    },
    // The fix with each change's line moved past the rows earlier writes added or removed above it. `absolute` maps
    // a change's file to the path its writes were recorded under.
    rebase(fix, absolute) {
      const changes = fix.changes.map((change) => {
        if (change.create) return change;
        let row = change.line - 1;
        for (const write of writesByFile.get(absolute(change.file)) ?? []) {
          if (write.row + write.removed <= row) row += write.delta;
        }
        return row === change.line - 1 ? change : { ...change, line: row + 1 };
      });
      return { ...fix, changes };
    },
    format(root) {
      const fs = require('node:fs');
      const files = [...segmentsByFile].map(([file, segments]) => ({
        file,
        segments,
        text: fs.readFileSync(file, 'utf8'),
        ranges: bottomFirst(rangesOf(segments)).map(({ start, end }) => [start, end]),
      }));
      const stepsByFile = formatRanges(
        root,
        files.map(({ file, text, ranges }) => ({ file, text, ranges })),
      );
      for (const { file, segments, text } of files) {
        const steps = stepsByFile?.get(file);
        const beforeRowsOf = (segment) => [...segment.owners].flatMap((owner) => beforeRowsByOwner.get(owner) ?? []);
        const formattedText = steps?.length
          ? steps.at(-1)
          : matchFileStyle(file, text, styleRegions(segments, beforeRowsOf));
        if (formattedText === text) continue;
        if (fs.readFileSync(file, 'utf8') !== text) continue;
        writeFileAtomic(file, formattedText);
        const formatted = ownedHunks(
          steps?.length ? followSteps(segments, text, steps) : segments,
          [],
          splitRows(formattedText),
        );
        for (const [owner, hunk] of formatted) if (owner) owner.after = hunk.after;
      }
    },
  };
}

function rangeOffsets(text, [startRow, endRow]) {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  const rangeEnd = endRow < starts.length ? starts[endRow] - 1 : text.length;
  return { rangeStart: starts[Math.min(startRow, starts.length - 1)], rangeEnd };
}

// Line hunks `{ start, end, rows }` that turn `before` rows into `after` rows, or undefined when the changed region
// is too large to compare.
function lineHunks(before, after) {
  const { first, beforeEnd, afterEnd } = changedRows(before, after);
  const left = before.slice(first, beforeEnd);
  const right = after.slice(first, afterEnd);
  if ((left.length + 1) * (right.length + 1) > maxDiffCells) return;
  // Longest common subsequence lengths of the suffixes left[i..] and right[j..].
  const width = right.length + 1;
  const common = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      common[i * width + j] =
        left[i] === right[j]
          ? common[(i + 1) * width + j + 1] + 1
          : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }
  const hunks = [];
  let open;
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      if (open) hunks.push(open);
      open = undefined;
      i++;
      j++;
      continue;
    }
    open ??= { start: first + i, end: first + i, rows: [] };
    if (j < right.length && (i === left.length || common[i * width + j + 1] >= common[(i + 1) * width + j])) {
      open.rows.push(right[j++]);
    } else open.end = first + ++i;
  }
  if (open) hunks.push(open);
  return hunks;
}

// Prettier widens a range to whole statements or members, such as a method whose parameters changed. Only the line
// hunks that touch the changed rows `[start, end)` are kept, so the rest of that method stays byte-identical. Returns
// undefined when that cannot be done safely.
function keptFormatting(file, text, formatted, [start, end]) {
  if (formatted === text) return text;
  const rows = splitRows(text);
  const hunks = lineHunks(rows, splitRows(formatted));
  if (!hunks) return;
  for (const hunk of hunks.reverse()) {
    const touches =
      hunk.start === hunk.end ? start <= hunk.start && hunk.start <= end : hunk.start < end && start < hunk.end;
    if (touches) rows.splice(hunk.start, hunk.end - hunk.start, ...hunk.rows);
  }
  const kept = rows.join('\n');
  // Hunks taken apart could split one change Prettier made across them, such as a moved parenthesis. A spliced
  // `formatted` from formattedSiblings can carry the same split, so the result is checked even when it is unchanged.
  return parseErrors(file, kept) <= parseErrors(file, text) ? kept : undefined;
}

function parseErrors(file, source) {
  const ts = require('typescript');
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest).parseDiagnostics.length;
}

// Prettier can also reformat a whole block around the range, rewriting a neighbouring statement that shares no
// unchanged row with the changed ones. This keeps only the formatted siblings that overlap the range: the innermost
// node holding the range has the same children in both texts, so their whole lines are swapped one for one.
// Returns undefined when the two parses do not line up.
function formattedSiblings(file, text, formatted, { rangeStart, rangeEnd }) {
  const ts = require('typescript');
  const parse = (source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const childrenOf = (node) => {
    const children = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    return children;
  };
  const original = parse(text);
  const indices = [];
  let holder = original;
  for (;;) {
    const children = childrenOf(holder);
    const index = children.findIndex((child) => child.pos <= rangeStart && rangeEnd <= child.end);
    if (index === -1) break;
    indices.push(index);
    holder = children[index];
  }
  const reformatted = parse(formatted);
  let formattedHolder = reformatted;
  for (const index of indices) formattedHolder = childrenOf(formattedHolder)[index];
  const sides = [
    { source: original, text, children: childrenOf(holder) },
    { source: reformatted, text: formatted, children: formattedHolder ? childrenOf(formattedHolder) : [] },
  ];
  const [left, right] = sides.map((side) => side.children);
  if (formattedHolder?.kind !== holder.kind || left.length !== right.length) return;
  if (left.some((child, index) => child.kind !== right[index].kind)) return;
  let first = left.findIndex((child) => child.end >= rangeStart);
  let last = left.findLastIndex((child) => child.getStart(original) <= rangeEnd);
  if (first === -1 || last < first) return;
  const lineStart = (side, offset) => side.text.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = (side, offset) => {
    const end = side.text.indexOf('\n', offset);
    return end === -1 ? side.text.length : end;
  };
  const spanOf = (side) => ({
    start: lineStart(side, side.children[first].getStart(side.source)),
    end: lineEnd(side, side.children[last].end),
  });
  // Siblings that share a line with the span are taken along, so both spans hold the same children.
  for (let widened = true; widened;) {
    widened = false;
    for (const side of sides) {
      const span = spanOf(side);
      if (first > 0 && side.children[first - 1].end > span.start) {
        first--;
        widened = true;
      }
      if (last < side.children.length - 1 && side.children[last + 1].getStart(side.source) < span.end) {
        last++;
        widened = true;
      }
    }
  }
  const [kept, replacement] = sides.map(spanOf);
  const spliced =
    text.slice(0, kept.start) + formatted.slice(replacement.start, replacement.end) + text.slice(kept.end);
  // Whole lines can hold more than the siblings: a call collapsed onto one line brings its closing `);` along while
  // the original `);` row stays outside the span.
  return parseErrors(file, spliced) <= parseErrors(file, text) ? spliced : undefined;
}

// Without Prettier, the changed rows of a fix take the file's own style: its semicolons, indentation and string
// quotes, read from the rows no fix wrote. A style the file does not clearly follow stays as the fix wrote it.
const dominantShare = 0.8;
const minimumStyleSamples = 3;
// Fix builders indent nested code by this many spaces on top of the indentation they copy from the file.
const builtIndentWidth = 2;
const quoteCharacters = ['"', "'"];
// A statement starting with one of these would continue the one before it once that one's semicolon is gone.
const continuationStarts = new Set(['(', '[', '`', '+', '-', '/', '<', '.', '*']);

// The style the samples clearly follow, or undefined.
function dominantStyle(counts) {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total < minimumStyleSamples) return;
  for (const [style, count] of counts) if (count / total >= dominantShare) return style;
}

function countStyle(counts, style) {
  counts.set(style, (counts.get(style) ?? 0) + 1);
}

// Statements that end in a semicolon when the file writes them.
const semicolonStatement = (ts, node) =>
  ts.isExpressionStatement(node) ||
  ts.isVariableStatement(node) ||
  ts.isReturnStatement(node) ||
  ts.isThrowStatement(node) ||
  ts.isBreakStatement(node) ||
  ts.isContinueStatement(node) ||
  ts.isDebuggerStatement(node) ||
  ts.isImportDeclaration(node) ||
  ts.isImportEqualsDeclaration(node) ||
  ts.isExportDeclaration(node) ||
  ts.isExportAssignment(node) ||
  ts.isTypeAliasDeclaration(node);

// Rows `[start, end)` that changes wrote, each with the rows it replaced.
function styleRegions(segments, beforeRowsOf) {
  const regions = [];
  let row = 0;
  let originalRow = 0;
  for (const segment of segments) {
    if (segment.owners)
      regions.push({ start: row, end: row + segment.length, beforeRows: beforeRowsOf(segment, originalRow) });
    row += segment.length;
    originalRow += segment.originalLength;
  }
  return regions;
}

const indentationOf = (row) => /^[ \t]*/.exec(row)[0];

// A tab, the file's run of spaces per level, or undefined.
function indentationStyle(samples) {
  const counts = new Map();
  const steps = new Map();
  let previousWidth = 0;
  for (const indentation of samples) {
    if (/^\t+$/.test(indentation)) countStyle(counts, '\t');
    else if (/^ +$/.test(indentation)) {
      countStyle(counts, ' ');
      if (indentation.length > previousWidth) countStyle(steps, indentation.length - previousWidth);
      previousWidth = indentation.length;
    }
  }
  const style = dominantStyle(counts);
  if (style !== ' ') return style;
  const width = [...steps].sort((left, right) => right[1] - left[1])[0]?.[0];
  return width ? ' '.repeat(width) : undefined;
}

// Re-indents the changed rows of a region that a builder nested in its own two-space unit, relative to the region's
// first row, whose indentation was copied from the file.
function indentationEdits(region, rows, lineStarts, editable, style) {
  if (!style || style === ' '.repeat(builtIndentWidth)) return [];
  const firstRow = rows.slice(region.start, region.end).findIndex((row) => row.trim());
  if (firstRow === -1) return [];
  const base = indentationOf(rows[region.start + firstRow]);
  const nested = [];
  for (let row = region.start; row < region.end; row++) {
    const indentation = indentationOf(rows[row]);
    if (!editable(row) || !rows[row].trim() || !indentation.startsWith(base)) continue;
    const extra = indentation.slice(base.length);
    if (/^ +$/.test(extra) && extra.length % builtIndentWidth === 0) nested.push({ row, indentation, extra });
  }
  // Nesting only in steps of twice the builder's unit may already be the file's own four spaces.
  if (!nested.some(({ extra }) => extra.length % (2 * builtIndentWidth) === builtIndentWidth)) return [];
  return nested.map(({ row, indentation, extra }) => ({
    start: lineStarts[row],
    end: lineStarts[row] + indentation.length,
    text: base + style.repeat(extra.length / builtIndentWidth),
  }));
}

// The file's own style, from the code outside `regions`.
function fileStyle(ts, sourceFile, rows, outside) {
  const { text } = sourceFile;
  const lineStarts = sourceFile.getLineStarts();
  const rowAt = (offset) => findLineIndex(lineStarts, offset);
  // Rows that start inside a string, template or comment, whose leading space belongs to that text.
  const insideText = new Set();
  const protect = (start, end) => {
    for (let row = rowAt(start) + 1; row <= rowAt(end); row++) insideText.add(row);
  };
  const nodeStarts = new Set();
  const statements = [];
  const strings = [];
  const visit = (node) => {
    const start = node.getStart(sourceFile);
    nodeStarts.add(start);
    for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) protect(range.pos, range.end);
    if (ts.isStringLiteral(node) || ts.isTemplateLiteral(node) || ts.isJsxText(node)) protect(start, node.end);
    if (semicolonStatement(ts, node)) statements.push(node);
    if (ts.isStringLiteral(node) && !ts.isJsxAttribute(node.parent)) strings.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  const indentSamples = [];
  rows.forEach((row, index) => {
    const indentation = indentationOf(row);
    if (!outside(index) || insideText.has(index) || !row.trim()) return;
    if (nodeStarts.has(lineStarts[index] + indentation.length)) indentSamples.push(indentation);
  });
  const semicolonCounts = new Map();
  for (const statement of statements) {
    if (outside(rowAt(statement.end - 1))) countStyle(semicolonCounts, text[statement.end - 1] === ';');
  }
  const quoteCounts = new Map();
  for (const literal of strings) {
    const raw = literal.getText(sourceFile);
    // A string holding a quote has its quotes chosen for it.
    if (
      !outside(rowAt(literal.getStart(sourceFile))) ||
      quoteCharacters.some((quote) => raw.slice(1, -1).includes(quote))
    )
      continue;
    if (quoteCharacters.includes(raw[0])) countStyle(quoteCounts, raw[0]);
  }
  return {
    insideText,
    statements,
    strings,
    semicolons: dominantStyle(semicolonCounts),
    quote: dominantStyle(quoteCounts),
    indentation: indentationStyle(indentSamples),
  };
}

// Adds or drops the semicolon ending each changed statement. One is dropped only where the next code starts on a
// later line and could not continue the statement.
function semicolonEdits(ts, sourceFile, statements, changedAt, semicolons) {
  if (semicolons === undefined) return [];
  const { text } = sourceFile;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, sourceFile.languageVariant, text);
  const edits = [];
  for (const { end } of statements) {
    const hasSemicolon = text[end - 1] === ';';
    if (!changedAt(end - 1) || semicolons === hasSemicolon) continue;
    if (semicolons) {
      edits.push({ start: end, end, text: ';' });
      continue;
    }
    scanner.setTextPos(end);
    const token = scanner.scan();
    const closes = token === ts.SyntaxKind.EndOfFileToken || token === ts.SyntaxKind.CloseBraceToken;
    if (!closes && (!scanner.hasPrecedingLineBreak() || continuationStarts.has(scanner.getTokenText()[0]))) continue;
    edits.push({ start: end - 1, end, text: '' });
  }
  return edits;
}

// Swaps the quotes of changed strings that hold no quote, so no escape changes.
function quoteEdits(sourceFile, strings, changedAt, quote) {
  if (!quote) return [];
  const edits = [];
  for (const literal of strings) {
    const start = literal.getStart(sourceFile);
    const raw = sourceFile.text.slice(start, literal.end);
    const body = raw.slice(1, -1);
    if (raw[0] === quote || !quoteCharacters.includes(raw[0]) || !changedAt(start) || !changedAt(literal.end - 1))
      continue;
    if (!quoteCharacters.some((character) => body.includes(character)))
      edits.push({ start, end: literal.end, text: quote + body + quote });
  }
  return edits;
}

// The text with the changed rows of `regions` in the file's own style. A row equal to one its change replaced is
// unchanged code and keeps its text. Never adds or removes a row, so row ownership still holds.
function matchFileStyle(file, text, regions) {
  if (!scriptFile.test(file) || !regions.length) return text;
  const ts = require('typescript');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (sourceFile.parseDiagnostics.length) return text;
  const lineStarts = sourceFile.getLineStarts();
  const rows = splitRows(text);
  const regionByRow = new Map();
  for (const region of regions) for (let row = region.start; row < region.end; row++) regionByRow.set(row, region);
  const withoutReturn = (row) => row.replace(/\r$/, '');
  const changed = (row) => {
    const region = regionByRow.get(row);
    if (!region) return false;
    return !region.beforeRows.some((before) => withoutReturn(before) === withoutReturn(rows[row]));
  };
  const changedAt = (offset) => changed(findLineIndex(lineStarts, offset));
  const style = fileStyle(ts, sourceFile, rows, (row) => !regionByRow.has(row));
  const reindentable = (row) => changed(row) && !style.insideText.has(row);
  const edits = [
    ...semicolonEdits(ts, sourceFile, style.statements, changedAt, style.semicolons),
    ...quoteEdits(sourceFile, style.strings, changedAt, style.quote),
    ...regions.flatMap((region) => indentationEdits(region, rows, lineStarts, reindentable, style.indentation)),
  ];
  if (!edits.length) return text;
  let styled = text;
  for (const edit of edits.sort((left, right) => right.start - left.start || right.end - left.end)) {
    styled = styled.slice(0, edit.start) + edit.text + styled.slice(edit.end);
  }
  return ts.createSourceFile(file, styled, ts.ScriptTarget.Latest).parseDiagnostics.length ? text : styled;
}

// The project's own Prettier: the nearest `node_modules/prettier` at or above `folder`. A global install, such as
// one on NODE_PATH, is not the project's formatter.
function projectPrettier(folder) {
  for (let directory = folder; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', 'prettier');
    if (require('node:fs').existsSync(path.join(candidate, 'package.json'))) {
      try {
        return require(candidate);
      } catch {
        return undefined;
      }
    }
    if (path.dirname(directory) === directory) return undefined;
  }
}

async function formatInChild({ root, files }) {
  const prettierByFolder = new Map();
  const loadPrettier = (file) => {
    const folder = path.dirname(file);
    if (!prettierByFolder.has(folder)) {
      prettierByFolder.set(folder, projectPrettier(folder));
    }
    return prettierByFolder.get(folder);
  };
  const results = [];
  let loaded = false;
  for (const { file, text, ranges } of files) {
    const prettier = loadPrettier(file);
    const steps = [];
    results.push({ file, steps });
    if (!prettier) continue;
    loaded = true;
    try {
      const info = await prettier.getFileInfo(file, { ignorePath: path.join(root, '.prettierignore') });
      if (info.ignored || !info.inferredParser) continue;
      const config = (await prettier.resolveConfig(file, { editorconfig: true })) ?? {};
      let current = text;
      for (const range of ranges) {
        // `auto` keeps the file's own line endings on the rows Prettier leaves alone.
        const offsets = rangeOffsets(current, range);
        const formatted = await prettier.format(current, {
          ...config,
          filepath: file,
          ...offsets,
          endOfLine: 'auto',
        });
        const siblings = formatted === current ? formatted : formattedSiblings(file, current, formatted, offsets);
        current = keptFormatting(file, current, siblings ?? formatted, range) ?? current;
        steps.push(current);
      }
    } catch {
      // Text Prettier cannot handle keeps the ranges formatted so far and is otherwise left as written.
    }
  }
  return loaded || !files.length ? { results } : { missing: true };
}

if (require.main === module) {
  const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
  formatInChild(input).then((output) => process.stdout.write(JSON.stringify(output)));
}

module.exports = {
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
