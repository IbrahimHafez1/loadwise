import type { SourceFile } from 'typescript';

// Third-party code and sample material that the project does not own, so its style is not the
// project's to fix.
const VENDORED_OR_SAMPLE_PATH =
  /(?:^|\/)(?:vendor|vendors|third[-_]party|assets|__fixtures__|__testfixtures__|fixtures?|docs?|documentation|examples?|\.github)\/|\.(?:input|output)\.[cm]?[jt]sx?$/i;
const LARGE_FILE_CHARACTERS = 200_000;
const LARGE_LICENSED_FILE_CHARACTERS = 50_000;
const LICENSE_HEADER_CHARACTERS = 2048;
const LIBRARY_LICENSE_MARKER = /@license|@preserve/;
const ESLINT_DIRECTIVE =
  /(?:\/\/|\/\*)\s*eslint-(disable-next-line|disable-line|disable|enable)\b([^\n]*?)(?:\*\/|$)/gm;

const NO_CONSOLE_RULES = ['no-console'];
const NO_UNUSED_RULES = [
  'no-unused-vars',
  '@typescript-eslint/no-unused-vars',
  'unused-imports/no-unused-imports',
  'unused-imports/no-unused-vars',
];

function isVendoredOrSamplePath(file: string): boolean {
  return VENDORED_OR_SAMPLE_PATH.test(file.replaceAll('\\', '/'));
}

// A bundled third-party library is not minified, so its size and license banner give it away.
function isBundledLibrary(sourceFile: SourceFile): boolean {
  const { text } = sourceFile;
  if (text.length > LARGE_FILE_CHARACTERS) return true;
  return (
    text.length > LARGE_LICENSED_FILE_CHARACTERS &&
    LIBRARY_LICENSE_MARKER.test(text.slice(0, LICENSE_HEADER_CHARACTERS))
  );
}

function directiveCovers(ruleList: string, rules: readonly string[]): boolean {
  const listed = ruleList
    .split('--')[0]
    .split(',')
    .map((rule) => rule.trim())
    .filter(Boolean);
  return listed.length === 0 || listed.some((rule) => rules.includes(rule));
}

/**
 * Lines (1-based) on which ESLint directives switch off any of `rules`. A bare `eslint-disable`
 * covers every rule, and a block disable lasts until a matching `eslint-enable`.
 */
function eslintDisabledLines(sourceFile: SourceFile, rules: readonly string[]): (line: number) => boolean {
  const { text } = sourceFile;
  if (!text.includes('eslint-')) return () => false;
  const singleLines = new Set<number>();
  const ranges: { start: number; end: number }[] = [];
  let openStart: number | undefined;
  const closeOpenRange = (end: number): void => {
    if (openStart !== undefined) ranges.push({ start: openStart, end });
    openStart = undefined;
  };
  for (const match of text.matchAll(ESLINT_DIRECTIVE)) {
    const [, kind, ruleList] = match;
    if (!directiveCovers(ruleList, rules)) continue;
    const line = sourceFile.getLineAndCharacterOfPosition(match.index).line + 1;
    if (kind === 'disable-next-line') singleLines.add(line + 1);
    else if (kind === 'disable-line') singleLines.add(line);
    else if (kind === 'disable') openStart ??= line;
    else closeOpenRange(line);
  }
  closeOpenRange(Number.POSITIVE_INFINITY);
  return (line) => singleLines.has(line) || ranges.some((range) => range.start <= line && line <= range.end);
}

export { NO_CONSOLE_RULES, NO_UNUSED_RULES, eslintDisabledLines, isBundledLibrary, isVendoredOrSamplePath };
