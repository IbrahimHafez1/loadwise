// Keeps the rule index in README.md in step with the one-page-per-rule docs in docs/rules/.
// Usage: npm run docs:rules rewrites each marker block in README.md; --check exits 1 when README.md is stale.
// A README marker block looks like
//   <!-- loadwise:rules:start checker=reliability group=migration-safety -->
//   <!-- loadwise:rules:end -->
// and holds one table row per page whose frontmatter has that checker and a group with that slug.

import fs from 'node:fs';
import path from 'node:path';
import prettier from 'prettier';
import {
  impactByRule as accessibilityImpact,
  descriptionByRule as accessibilityDescriptions,
} from '../lib/accessibility/rule-ids.js';
import {
  impactByRule as maintainabilityImpact,
  descriptionByRule as maintainabilityDescriptions,
} from '../lib/maintainability/rule-ids.js';
import {
  impactByRule as performanceImpact,
  descriptionByRule as performanceDescriptions,
} from '../lib/performance/rule-ids.js';
import {
  impactByRule as reliabilityImpact,
  descriptionByRule as reliabilityDescriptions,
} from '../lib/reliability/rule-ids.js';
import { descriptionByRule as securityDescriptions } from '../lib/security/rule-descriptions.js';
import { undocumentedRules } from '../lib/shared/rule-docs.js';
import {
  impactByRule as securityImpact,
  polyglotRules as securityPolyglotRules,
  securityRules,
} from '../lib/security/rule-ids.js';

const CHECKERS = ['performance', 'reliability', 'maintainability', 'security', 'accessibility'] as const;
type Checker = (typeof CHECKERS)[number];

const FIXABLE_VALUES = ['none', 'inline', 'manual'] as const;
type Fixable = (typeof FIXABLE_VALUES)[number];

const RULE_DOCS_DIR = 'docs/rules';
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
const MARKER_PATTERN =
  /<!-- loadwise:rules:start checker=([a-z]+) group=([a-z0-9-]+) -->[\s\S]*?<!-- loadwise:rules:end -->/g;

interface RuleRecord {
  id: string;
  checker: Checker;
  impact: string;
  description: string;
}

interface RulePage {
  id: string;
  title: string;
  description: string;
  checker: string;
  group: string;
  impact: string;
  fixable: string;
  related: string[];
  body: string;
}

const isChecker = (value: string): value is Checker => CHECKERS.some((checker) => checker === value);
const isFixable = (value: string): value is Fixable => FIXABLE_VALUES.some((fixable) => fixable === value);

function recordsFor(
  checker: Checker,
  ruleIds: readonly string[],
  impacts: Readonly<Record<string, string>>,
  descriptions: Readonly<Record<string, string>>,
): RuleRecord[] {
  return ruleIds
    .filter((id) => !undocumentedRules.has(id))
    .map((id) => {
      const impact = impacts[id];
      const description = descriptions[id];
      if (!impact || !description) throw new Error(`${checker} rule ${id} has no impact or description`);
      return { id, checker, impact, description };
    });
}

// The registered rules of all five checkers, the ids that need a page.
function readRegistry(): RuleRecord[] {
  const records = [
    ...recordsFor('performance', Object.keys(performanceImpact), performanceImpact, performanceDescriptions),
    ...recordsFor('reliability', Object.keys(reliabilityImpact), reliabilityImpact, reliabilityDescriptions),
    ...recordsFor(
      'maintainability',
      Object.keys(maintainabilityImpact),
      maintainabilityImpact,
      maintainabilityDescriptions,
    ),
    ...recordsFor('accessibility', Object.keys(accessibilityImpact), accessibilityImpact, accessibilityDescriptions),
    ...recordsFor('security', [...securityRules, ...securityPolyglotRules], securityImpact, securityDescriptions),
  ];
  const seen = new Set<string>();
  for (const { id } of records) {
    if (seen.has(id)) throw new Error(`Rule id ${id} is registered twice`);
    seen.add(id);
  }
  return records;
}

function parseFrontmatterValue(raw: string): string | string[] {
  if (raw.startsWith('"')) {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'string') throw new Error(`Expected a string, got ${raw}`);
    return parsed;
  }
  if (raw.startsWith('[')) {
    return raw
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return raw;
}

function frontmatterText(fields: Map<string, string | string[]>, key: string, file: string): string {
  const value = fields.get(key);
  if (typeof value !== 'string' || !value) throw new Error(`${file}: frontmatter needs a text value for "${key}"`);
  return value;
}

function parsePage(file: string, text: string): RulePage {
  const match = FRONTMATTER_PATTERN.exec(text.replaceAll('\r\n', '\n'));
  if (!match) throw new Error(`${file}: expected frontmatter between --- lines`);
  const fields = new Map<string, string | string[]>();
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(': ');
    if (separator === -1) throw new Error(`${file}: cannot read frontmatter line "${line}"`);
    fields.set(line.slice(0, separator), parseFrontmatterValue(line.slice(separator + 2)));
  }
  const related = fields.get('related') ?? [];
  if (typeof related === 'string') throw new Error(`${file}: "related" must be a list`);
  return {
    id: frontmatterText(fields, 'id', file),
    title: frontmatterText(fields, 'title', file),
    description: frontmatterText(fields, 'description', file),
    checker: frontmatterText(fields, 'checker', file),
    group: frontmatterText(fields, 'group', file),
    impact: frontmatterText(fields, 'impact', file),
    fixable: frontmatterText(fields, 'fixable', file),
    related,
    body: match[2],
  };
}

function readPages(rootDir: string): { file: string; page: RulePage }[] {
  const pagesDir = path.join(rootDir, RULE_DOCS_DIR);
  return fs
    .readdirSync(pagesDir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({ file: name, page: parsePage(name, fs.readFileSync(path.join(pagesDir, name), 'utf8')) }));
}

const groupSlug = (group: string): string =>
  group
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');

const escapeCell = (text: string): string => text.replaceAll('|', '\\|');

function indexRow(page: RulePage): string {
  const rule = `<a id="${page.id}"></a>[\`${page.id}\`](${RULE_DOCS_DIR}/${page.id}.md)`;
  return `| ${rule} | ${page.impact} | ${escapeCell(page.description)} |`;
}

function indexBlock(checker: string, groupKey: string, pages: readonly RulePage[]): string {
  const rows = pages
    .filter((page) => page.checker === checker && groupSlug(page.group) === groupKey)
    .sort((left, right) => (left.id < right.id ? -1 : 1))
    .map(indexRow);
  if (rows.length === 0) throw new Error(`README marker checker=${checker} group=${groupKey} matches no rule page`);
  return [
    `<!-- loadwise:rules:start checker=${checker} group=${groupKey} -->`,
    '',
    '| Rule | Impact | What it flags |',
    '| --- | --- | --- |',
    ...rows,
    '',
    '<!-- loadwise:rules:end -->',
  ].join('\n');
}

// Pages that no README marker covers would be missing from the index, so they fail the build.
function uncoveredPages(readme: string, pages: readonly RulePage[]): string[] {
  const covered = new Set([...readme.matchAll(MARKER_PATTERN)].map((match) => `${match[1]}/${match[2]}`));
  return pages.filter((page) => !covered.has(`${page.checker}/${groupSlug(page.group)}`)).map((page) => page.id);
}

async function renderReadme(readmePath: string, readme: string, pages: readonly RulePage[]): Promise<string> {
  const uncovered = uncoveredPages(readme, pages);
  if (uncovered.length > 0) {
    throw new Error(`No README marker block covers the checker and group of: ${uncovered.join(', ')}`);
  }
  const withIndex = readme.replaceAll(MARKER_PATTERN, (_block, checker: string, groupKey: string) =>
    indexBlock(checker, groupKey, pages),
  );
  const options = (await prettier.resolveConfig(readmePath)) ?? {};
  return prettier.format(withIndex, { ...options, filepath: readmePath });
}

async function main(argv: readonly string[]): Promise<number> {
  const rootDir = path.join(import.meta.dirname, '..');
  const readmePath = path.join(rootDir, 'README.md');
  const current = fs.readFileSync(readmePath, 'utf8').replaceAll('\r\n', '\n');
  const pages = readPages(rootDir).map(({ page }) => page);
  const updated = await renderReadme(readmePath, current, pages);
  if (argv.includes('--check')) {
    if (updated === current) return 0;
    console.error('README.md rule index is stale. Run: npm run docs:rules');
    return 1;
  }
  if (updated !== current) fs.writeFileSync(readmePath, updated);
  console.log(updated === current ? 'README.md rule index is up to date.' : 'Updated the README.md rule index.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}

export {
  CHECKERS,
  FIXABLE_VALUES,
  RULE_DOCS_DIR,
  groupSlug,
  isChecker,
  isFixable,
  parsePage,
  readPages,
  readRegistry,
  renderReadme,
};
export type { Checker, Fixable, RulePage, RuleRecord };
