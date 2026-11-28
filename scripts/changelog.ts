// Folds the changelog fragments in changes/ into the [Unreleased] section of CHANGELOG.md and deletes them.
// Usage: npm run changelog. The format is described in changes/README.md.

import fs from 'node:fs';
import path from 'node:path';

// Keep a Changelog order, used to place a heading that [Unreleased] does not have yet.
const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'] as const;
type Section = (typeof SECTIONS)[number];

const UNRELEASED_HEADING = '## [Unreleased]';
const FRAGMENT_README = 'README.md';
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

interface Fragment {
  section: Section;
  entries: string;
}

const isSection = (value: string): value is Section => SECTIONS.some((section) => section === value);

function parseFragment(name: string, text: string): Fragment {
  const match = FRONTMATTER_PATTERN.exec(text);
  if (!match) throw new Error(`${name}: expected frontmatter with "section: <name>" between --- lines`);
  const sectionLine = /^section:[ \t]*(.*?)[ \t]*$/m.exec(match[1]);
  const section = sectionLine?.[1] ?? '';
  if (!isSection(section)) {
    throw new Error(`${name}: unknown section "${section}", use one of ${SECTIONS.join(', ')}`);
  }
  const body = match[2].trim();
  if (!body) throw new Error(`${name}: the entry text is empty`);
  // A body that is not already a bullet list is one entry; a list keeps its bullets as written.
  return { section, entries: body.startsWith('- ') ? body : `- ${body}` };
}

function readFragments(changesDir: string): { name: string; fragment: Fragment }[] {
  if (!fs.existsSync(changesDir)) return [];
  return fs
    .readdirSync(changesDir)
    .filter((name) => name.endsWith('.md') && name !== FRAGMENT_README)
    .sort()
    .map((name) => ({ name, fragment: parseFragment(name, fs.readFileSync(path.join(changesDir, name), 'utf8')) }));
}

// Inserts the entries after the last entry of the section's first heading, creating the heading in order if missing.
function addToUnreleased(lines: string[], { section, entries }: Fragment): void {
  const start = lines.indexOf(UNRELEASED_HEADING);
  if (start === -1) throw new Error(`CHANGELOG.md has no "${UNRELEASED_HEADING}" heading`);
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  if (end === -1) end = lines.length;

  const headings: { section: string; index: number }[] = [];
  for (let index = start + 1; index < end; index++) {
    if (lines[index].startsWith('### ')) headings.push({ section: lines[index].slice(4).trim(), index });
  }

  const existing = headings.find((heading) => heading.section === section);
  if (existing) {
    const next = headings.find((heading) => heading.index > existing.index);
    let last = (next?.index ?? end) - 1;
    while (lines[last].trim() === '') last--;
    lines.splice(last + 1, 0, ...entries.split('\n'));
    return;
  }

  const later = headings.find(
    (heading) => SECTIONS.findIndex((name) => name === heading.section) > SECTIONS.indexOf(section),
  );
  const insertAt = later?.index ?? end;
  const block = [`### ${section}`, '', ...entries.split('\n'), ''];
  if (!later) {
    // Appended at the end of the section: keep one blank line before it and before the next release heading.
    let last = insertAt - 1;
    while (lines[last].trim() === '') last--;
    lines.splice(last + 1, insertAt - last - 1, '', ...block);
    return;
  }
  lines.splice(insertAt, 0, ...block);
}

function foldFragments(rootDir: string): string[] {
  const changelogPath = path.join(rootDir, 'CHANGELOG.md');
  const changesDir = path.join(rootDir, 'changes');
  const fragments = readFragments(changesDir);
  if (fragments.length === 0) return [];

  const lines = fs.readFileSync(changelogPath, 'utf8').split(/\r?\n/);
  for (const { fragment } of fragments) addToUnreleased(lines, fragment);
  fs.writeFileSync(changelogPath, lines.join('\n'));
  for (const { name } of fragments) fs.rmSync(path.join(changesDir, name));
  return fragments.map(({ name }) => name);
}

function main(): number {
  try {
    const folded = foldFragments(path.join(import.meta.dirname, '..'));
    console.log(
      folded.length === 0
        ? 'No changelog fragments to fold.'
        : `Folded ${folded.length} fragment(s): ${folded.join(', ')}`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.exitCode = main();

export { SECTIONS, parseFragment, readFragments, foldFragments };
