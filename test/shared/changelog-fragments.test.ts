import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { foldFragments, parseFragment, readFragments } from '../../scripts/changelog.js';
import type { TestContext } from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');

const sampleChangelog = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- First existing entry.',
  '',
  '### Fixed',
  '',
  '- Existing fix.',
  '',
  '### Added',
  '',
  '- Duplicate heading entry.',
  '',
  '## [1.0.0] - 2026-01-01',
  '',
  '### Added',
  '',
  '- Released entry.',
  '',
].join('\n');

function fragmentText(section: string, body: string): string {
  return `---\nsection: ${section}\n---\n\n${body}\n`;
}

function project(context: TestContext, fragments: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-changelog-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), sampleChangelog);
  fs.mkdirSync(path.join(root, 'changes'));
  for (const [name, text] of Object.entries(fragments)) fs.writeFileSync(path.join(root, 'changes', name), text);
  return root;
}

test('every committed fragment parses', () => {
  const fragments = readFragments(path.join(repoRoot, 'changes'));
  for (const { name, fragment } of fragments) assert.ok(fragment.entries.startsWith('- '), name);
});

test('folds into an existing heading after its entries and deletes the fragment', (context) => {
  const root = project(context, { 'a-fix.md': fragmentText('Fixed', 'New fix.') });
  assert.deepEqual(foldFragments(root), ['a-fix.md']);
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes('- Existing fix.\n- New fix.\n\n### Added\n\n- Duplicate'));
  assert.deepEqual(fs.readdirSync(path.join(root, 'changes')), []);
});

test('uses the first matching heading and keeps several bullets', (context) => {
  const root = project(context, { 'two.md': fragmentText('Added', '- One.\n- Two.') });
  foldFragments(root);
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes('- First existing entry.\n- One.\n- Two.\n\n### Fixed'));
});

test('creates a missing heading in Keep a Changelog order', (context) => {
  const root = project(context, {
    'changed.md': fragmentText('Changed', 'Changed thing.'),
    'security.md': fragmentText('Security', 'Security thing.'),
  });
  foldFragments(root);
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes('- First existing entry.\n\n### Changed\n\n- Changed thing.\n\n### Fixed'));
  assert.ok(changelog.includes('- Duplicate heading entry.\n\n### Security\n\n- Security thing.\n\n## [1.0.0]'));
});

test('rejects an unknown section and an empty body without touching the changelog', (context) => {
  assert.throws(() => parseFragment('bad.md', fragmentText('Improved', 'Text.')), /unknown section "Improved"/);
  assert.throws(() => parseFragment('empty.md', fragmentText('Added', '')), /entry text is empty/);
  const root = project(context, { 'bad.md': fragmentText('Improved', 'Text.'), 'ok.md': fragmentText('Added', 'Ok.') });
  assert.throws(() => foldFragments(root), /bad\.md/);
  assert.equal(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), sampleChangelog);
  assert.deepEqual(fs.readdirSync(path.join(root, 'changes')).sort(), ['bad.md', 'ok.md']);
});

test('ignores the README in the changes directory', (context) => {
  const root = project(context, { 'README.md': '# not a fragment' });
  assert.deepEqual(foldFragments(root), []);
});

test('accepts a changelog with CRLF line endings', (context) => {
  const root = project(context, { 'crlf.md': fragmentText('Fixed', 'Crlf fix.') });
  const changelogPath = path.join(root, 'CHANGELOG.md');
  fs.writeFileSync(changelogPath, sampleChangelog.replaceAll('\n', '\r\n'));
  foldFragments(root);
  assert.ok(fs.readFileSync(changelogPath, 'utf8').includes('- Existing fix.\n- Crlf fix.\n'));
});
