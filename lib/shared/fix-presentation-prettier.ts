import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Node, SourceFile } from 'typescript';
import { changedRows, splitRows } from './fix-presentation-rows.js';
import type {
  FormatFile,
  FormatOutput,
  FormatRequest,
  FormatSide,
  LineHunk,
  PrettierApi,
  TypeScript,
} from './types/fix-presentation.js';

const missingPrettierNote = 'Install prettier in the project to format applied fixes.';
const scriptFile = /\.[cm]?[jt]sx?$/i;
// Generous: a run formats every changed range of every touched file in one process.
const formatTimeoutMs = 120_000;
const formatOutputLimit = 1 << 30;
// Comparing larger reformatted regions line by line costs more than formatting is worth.
const maxDiffCells = 4_000_000;

// Formats row ranges `[start, end)` of each file with the Prettier its folder resolves. Returns a
// map from file to the text after each range, bottom range first, or undefined when no file could
// load Prettier.
function formatRanges(
  entryFile: string,
  root: string,
  files: readonly FormatFile[],
): Map<string, string[]> | undefined {
  const scripts = files.filter(({ file, ranges }: FormatFile) => scriptFile.test(file) && ranges.length);
  if (!scripts.length) return new Map<string, string[]>();
  const child = spawnSync(process.execPath, [entryFile], {
    input: JSON.stringify({ root, files: scripts }),
    encoding: 'utf8',
    maxBuffer: formatOutputLimit,
    timeout: formatTimeoutMs,
    windowsHide: true,
  });
  let output: FormatOutput;
  try {
    output = JSON.parse(child.stdout);
  } catch {
    console.error('Could not format applied fixes: ' + (child.error?.message ?? child.stderr.trim()));
    return new Map<string, string[]>();
  }
  if (output.missing) {
    console.error(missingPrettierNote);
    return;
  }
  return new Map((output.results ?? []).map(({ file, steps }): [string, string[]] => [file, steps]));
}

function rangeOffsets(
  text: string,
  [startRow, endRow]: readonly [number, number],
): { rangeStart: number; rangeEnd: number } {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  const rangeEnd = endRow < starts.length ? starts[endRow] - 1 : text.length;
  return { rangeStart: starts[Math.min(startRow, starts.length - 1)], rangeEnd };
}

// Line hunks `{ start, end, rows }` that turn `before` rows into `after` rows, or undefined when
// the changed region is too large to compare.
function lineHunks(before: readonly string[], after: readonly string[]): LineHunk[] | undefined {
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
  const hunks: LineHunk[] = [];
  let open: LineHunk | undefined;
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

function parseErrors(loadTs: () => TypeScript, file: string, source: string): number {
  const ts = loadTs();
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest).parseDiagnostics?.length ?? 0;
}

// Prettier widens a range to whole statements or members, such as a method whose parameters
// changed. Only the line hunks that touch the changed rows `[start, end)` are kept, so the rest of
// that method stays byte-identical. Returns undefined when that cannot be done safely.
function keptFormatting(
  loadTs: () => TypeScript,
  file: string,
  text: string,
  formatted: string,
  [start, end]: readonly [number, number],
): string | undefined {
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
  // Hunks taken apart could split one change Prettier made across them, such as a moved
  // parenthesis. A spliced `formatted` from formattedSiblings can carry the same split, so the
  // result is checked even when it is unchanged.
  return parseErrors(loadTs, file, kept) <= parseErrors(loadTs, file, text) ? kept : undefined;
}

// Prettier can also reformat a whole block around the range, rewriting a neighbouring statement
// that shares no unchanged row with the changed ones. This keeps only the formatted siblings that
// overlap the range: the innermost node holding the range has the same children in both texts, so
// their whole lines are swapped one for one. Returns undefined when the two parses do not line up.
function formattedSiblings(
  loadTs: () => TypeScript,
  file: string,
  text: string,
  formatted: string,
  { rangeStart, rangeEnd }: { rangeStart: number; rangeEnd: number },
): string | undefined {
  const ts = loadTs();
  const parse = (source: string): SourceFile => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const childrenOf = (node: Node): Node[] => {
    const children: Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    return children;
  };
  const original = parse(text);
  const indices: number[] = [];
  let holder: Node = original;
  for (;;) {
    const children = childrenOf(holder);
    const index = children.findIndex((child) => child.pos <= rangeStart && rangeEnd <= child.end);
    if (index === -1) break;
    indices.push(index);
    holder = children[index];
  }
  const reformatted = parse(formatted);
  let formattedHolder: Node = reformatted;
  for (const index of indices) formattedHolder = childrenOf(formattedHolder)[index];
  const sides: FormatSide[] = [
    { source: original, text, children: childrenOf(holder) },
    { source: reformatted, text: formatted, children: formattedHolder ? childrenOf(formattedHolder) : [] },
  ];
  const [left, right] = sides.map((side) => side.children);
  if (formattedHolder?.kind !== holder.kind || left.length !== right.length) return;
  if (left.some((child, index) => child.kind !== right[index].kind)) return;
  let first = left.findIndex((child) => child.end >= rangeStart);
  let last = left.findLastIndex((child) => child.getStart(original) <= rangeEnd);
  if (first === -1 || last < first) return;
  const lineStart = (side: FormatSide, offset: number): number => side.text.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = (side: FormatSide, offset: number): number => {
    const end = side.text.indexOf('\n', offset);
    return end === -1 ? side.text.length : end;
  };
  const spanOf = (side: FormatSide): { start: number; end: number } => ({
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
  // Whole lines can hold more than the siblings: a call collapsed onto one line brings its closing
  // `);` along while the original `);` row stays outside the span.
  return parseErrors(loadTs, file, spliced) <= parseErrors(loadTs, file, text) ? spliced : undefined;
}

async function formatInChild(
  { root, files }: FormatRequest,
  {
    projectPrettier,
    loadTs,
  }: { projectPrettier: (folder: string) => PrettierApi | undefined; loadTs: () => TypeScript },
): Promise<FormatOutput> {
  const prettierByFolder = new Map<string, PrettierApi | undefined>();
  const loadPrettier = (file: string): PrettierApi | undefined => {
    const folder = path.dirname(file);
    if (!prettierByFolder.has(folder)) {
      prettierByFolder.set(folder, projectPrettier(folder));
    }
    return prettierByFolder.get(folder);
  };
  const results: { file: string; steps: string[] }[] = [];
  let loaded = false;
  for (const { file, text, ranges } of files) {
    const prettier = loadPrettier(file);
    const steps: string[] = [];
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
        const siblings =
          formatted === current ? formatted : formattedSiblings(loadTs, file, current, formatted, offsets);
        current = keptFormatting(loadTs, file, current, siblings ?? formatted, range) ?? current;
        steps.push(current);
      }
    } catch {
      // Text Prettier cannot handle keeps the ranges formatted so far and is otherwise left as written.
    }
  }
  return loaded || !files.length ? { results } : { missing: true };
}

export { formatInChild, formatRanges, missingPrettierNote, scriptFile };
