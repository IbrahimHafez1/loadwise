'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { describe, test } = require('node:test');

const {
  applyReviewComments,
  baselinePolicy,
  changedFilesSince,
  changedSincePolicy,
  hashMigration,
  readBaseline,
  writeBaseline,
} = require('../lib/migrations/enforce.cjs');

function temporaryDirectory(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-enforce-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(root, name, text) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), text);
  return path.join(root, name);
}

describe('migration baseline', () => {
  test('hashes ignore line endings and a byte order mark', () => {
    assert.equal(hashMigration('SELECT 1;\r\nSELECT 2;\r\n'), hashMigration('﻿SELECT 1;\nSELECT 2;\n'));
    assert.notEqual(hashMigration('SELECT 1;'), hashMigration('SELECT 2;'));
  });

  test('round trip: listed unchanged files are not enforced, edited and new files are', (context) => {
    const root = temporaryDirectory(context);
    const baselineFile = path.join(root, 'backend-perf.migrations-baseline.json');
    const old = {
      path: write(root, 'migrations/001.sql', 'CREATE INDEX i ON t (a);'),
      text: 'CREATE INDEX i ON t (a);',
    };
    assert.equal(readBaseline(baselineFile), null);
    assert.equal(writeBaseline(baselineFile, [old]), 1);
    const document = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    assert.deepEqual(Object.keys(document.files), ['migrations/001.sql']);
    assert.equal(document.version, 1);

    const policy = baselinePolicy(baselineFile, readBaseline(baselineFile));
    assert.equal(policy.reason, 'Migration predates the baseline.');
    assert.equal(policy.isEnforced(old), false);
    assert.equal(policy.isEnforced({ ...old, text: old.text + '\nDROP TABLE t;' }), true);
    assert.equal(policy.isEnforced({ path: path.join(root, 'migrations/002.sql'), text: 'x' }), true);
  });

  test('an invalid baseline is a configuration error', (context) => {
    const root = temporaryDirectory(context);
    const broken = write(root, 'a.json', '{');
    assert.throws(() => readBaseline(broken), /invalid JSON/);
    const wrongVersion = write(root, 'b.json', '{"version":2,"files":{}}');
    assert.throws(() => readBaseline(wrongVersion), /"version": 1/);
  });
});

describe('review comments', () => {
  test('a directive on the line before the finding makes it contextual', () => {
    const sql =
      '-- backend-perf-reviewed migration-breaking-drop -- No release reads it since 2.4.\nDROP TABLE old;\nDROP TABLE other;';
    const findings = applyReviewComments(
      [
        { line: 2, ruleId: 'migration-breaking-drop' },
        { line: 3, ruleId: 'migration-breaking-drop' },
      ],
      sql,
      true,
    );
    assert.equal(findings[0].contextualReason, 'Reviewed in source: No release reads it since 2.4.');
    assert.equal(findings[1].contextualReason, undefined);
  });

  test('the directive must name the exact rule; code files also accept // comments', () => {
    const [other] = applyReviewComments(
      [{ line: 2, ruleId: 'migration-breaking-rename' }],
      '-- backend-perf-reviewed migration-breaking-drop -- reason\nALTER TABLE t RENAME TO u;',
      true,
    );
    assert.equal(other.contextualReason, undefined);
    const [code] = applyReviewComments(
      [{ line: 2, ruleId: 'migration-breaking-drop' }],
      '    // backend-perf-reviewed migration-breaking-drop -- Unused since 2.4.\n    await queryRunner.query(`DROP TABLE old`);',
      false,
    );
    assert.equal(code.contextualReason, 'Reviewed in source: Unused since 2.4.');
  });
});

describe('--changed-since', () => {
  test('files added or modified since the merge base, plus untracked files', (context) => {
    const root = temporaryDirectory(context);
    git(root, 'init', '-q', '-b', 'main');
    write(root, 'migrations/001.sql', 'SELECT 1;');
    write(root, 'migrations/002.sql', 'SELECT 2;');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'feature');
    write(root, 'migrations/002.sql', 'SELECT 22;');
    write(root, 'migrations/003.sql', 'SELECT 3;');
    git(root, 'add', 'migrations/003.sql');
    git(root, 'commit', '-q', '-m', 'feature');
    write(root, 'migrations/004.sql', 'SELECT 4;');

    const changed = [...changedFilesSince('main', path.join(root, 'migrations'))].map((file) => path.basename(file));
    assert.deepEqual(changed.sort(), ['002.sql', '003.sql', '004.sql']);
    const policy = changedSincePolicy('main', root);
    assert.equal(policy.isEnforced({ path: path.join(root, 'migrations', '001.sql') }), false);
    assert.equal(policy.isEnforced({ path: path.join(root, 'migrations', '003.sql') }), true);
    assert.equal(policy.reason, 'Migration is unchanged since main.');
  });

  test('a ref that looks like an option is rejected before git runs', (context) => {
    const root = temporaryDirectory(context);
    const marker = path.join(root, 'injected');
    assert.throws(() => changedFilesSince('--output=' + marker, root), /refs starting with "-" are rejected/);
    assert.throws(() => changedFilesSince('', root), /needs a git ref/);
    assert.equal(fs.existsSync(marker), false);
  });

  test('an unresolvable ref asks to fetch full history', (context) => {
    const root = temporaryDirectory(context);
    git(root, 'init', '-q', '-b', 'main');
    write(root, 'a.sql', 'SELECT 1;');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    assert.throws(() => changedFilesSince('origin/main', root), /fetch full history/);
    assert.throws(() => changedFilesSince('main;touch x', root), /fetch full history/);
  });

  test('outside a repository it is a configuration error', (context) => {
    const root = temporaryDirectory(context);
    assert.throws(() => changedFilesSince('main', root), /needs a git repository/);
  });
});
