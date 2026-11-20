'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { describe, test } = require('node:test');

const CLI = path.join(__dirname, '..', '..', 'lib', 'performance', 'migrations', 'cli.cjs');
const RUNNER = `require(${JSON.stringify(CLI)}).run(process.argv.slice(1)).then((code) => { process.exitCode = code; });`;
// A database URL that cannot resolve: the checks must succeed without ever using it.
const SENTINEL_DATABASE_URL = 'postgres://sentinel:sentinel@sentinel.invalid:1/never';
const OLD_MIGRATION = 'prisma/migrations/20240101_init/migration.sql';
const NEW_MIGRATION = 'prisma/migrations/20240102_index/migration.sql';

function temporaryProject(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-migrations-cli-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'package.json', '{"dependencies":{"@prisma/client":"6"}}');
  write(root, 'prisma/schema.prisma', '');
  write(root, 'prisma/migrations/migration_lock.toml', 'provider = "postgresql"\n');
  write(root, OLD_MIGRATION, "SET lock_timeout = '5s';\nALTER TABLE orders DROP COLUMN legacy;\n");
  return root;
}

function write(root, name, text) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), text);
}

function migrations(cwd, ...args) {
  const result = spawnSync(process.execPath, ['-e', RUNNER, '--', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: SENTINEL_DATABASE_URL },
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('loadwise perf migrations', () => {
  test('without a baseline every migration is enforced, with one stderr hint', (context) => {
    const root = temporaryProject(context);
    const { code, stdout, stderr } = migrations(root);
    assert.equal(code, 1);
    assert.match(
      stdout,
      /^prisma\/migrations\/20240101_init\/migration\.sql:2:\d+ \[migration-breaking-drop #[0-9a-f]{12}\] /m,
    );
    assert.match(stdout, /1 migration file\(s\) checked, 1 finding\(s\)\./);
    assert.equal(stderr.trim().split('\n').length, 1);
    assert.match(stderr, /All 1 migration file\(s\) are enforced\. Run `loadwise perf migrations --write-baseline`/);
  });

  test('--write-baseline accepts existing files; only new ones fail; old findings are contextual', (context) => {
    const root = temporaryProject(context);
    const written = migrations(root, '--write-baseline');
    assert.equal(written.code, 0);
    assert.match(written.stdout, /Wrote 1 migration file\(s\) to backend-perf\.migrations-baseline\.json\./);

    const accepted = migrations(root);
    assert.equal(accepted.code, 0);
    assert.equal(accepted.stderr, '');
    assert.match(accepted.stdout, /0 finding\(s\)\.\n1 contextual finding\(s\) available with --include-contextual\./);

    write(root, NEW_MIGRATION, 'CREATE INDEX orders_id_idx ON orders (id);\n');
    const { code, stdout } = migrations(root, '--json', '--include-contextual');
    assert.equal(code, 1);
    const result = JSON.parse(stdout);
    assert.equal(result.scannedFiles, 2);
    assert.equal(result.contextualFindingCount, 1);
    const byRule = Object.fromEntries(result.findings.map((finding) => [finding.ruleId, finding]));
    assert.equal(byRule['migration-breaking-drop'].contextualReason, 'Migration predates the baseline.');
    assert.equal(byRule['migration-index-not-concurrent'].file, NEW_MIGRATION);
    assert.equal(byRule['migration-index-not-concurrent'].contextualReason, undefined);
    assert.equal(typeof byRule['migration-index-not-concurrent'].example.after, 'string');

    const ignored = migrations(
      root,
      '--ignore',
      'migration-index-not-concurrent',
      '--ignore',
      'migration-missing-lock-timeout',
    );
    assert.equal(ignored.code, 0);
  });

  test('explicit paths are checked without discovery', (context) => {
    const root = temporaryProject(context);
    write(root, 'loose/add.sql', 'ALTER TABLE users ADD COLUMN state text NOT NULL;\n');
    const { code, stdout } = migrations(root, 'loose/add.sql', '--dialect', 'postgres', '--json');
    assert.equal(code, 1);
    const result = JSON.parse(stdout);
    assert.equal(result.scannedFiles, 1);
    assert.ok(result.findings.some((finding) => finding.ruleId === 'migration-not-null-without-default'));
  });

  test('helper modules next to code migrations are neither counted nor baselined', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-migrations-cli-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    write(root, 'package.json', '{"dependencies":{"pg":"8","typeorm":"0.3"}}');
    write(
      root,
      'src/migrations/1700000000001-AddNote.ts',
      "export class AddNote1700000000001 { async up(queryRunner) { await queryRunner.query(\"SET lock_timeout = '5s'\"); await queryRunner.query('ALTER TABLE orders ADD COLUMN note text'); } }\n",
    );
    write(
      root,
      'src/migrations/support/lock-timeout.ts',
      'export async function withLockTimeout(queryRunner) { await queryRunner.query("SET lock_timeout = \'5s\'"); }\n',
    );
    const { stdout } = migrations(root, '--json');
    assert.equal(JSON.parse(stdout).scannedFiles, 1);
    const written = migrations(root, '--write-baseline');
    assert.match(written.stdout, /Wrote 1 migration file\(s\)/);
  });

  test('invalid input exits 2', (context) => {
    const root = temporaryProject(context);
    const unknownRule = migrations(root, '--ignore', 'no-such-rule');
    assert.equal(unknownRule.code, 2);
    assert.match(unknownRule.stderr, /Unknown migration rule: no-such-rule/);
    assert.equal(migrations(root, '--dialect', 'sqlite').code, 2);
    assert.equal(migrations(root, '--baseline', 'missing.json').code, 2);
    assert.equal(migrations(root, '--write-baseline', '--changed-since', 'main').code, 2);
    assert.equal(migrations(root, '--unknown-flag').code, 2);
  });

  test('--changed-since with an unresolvable ref exits 2 with the fetch hint', (context) => {
    const root = temporaryProject(context);
    const git = (...args) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
        cwd: root,
        stdio: 'ignore',
      });
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const missing = migrations(root, '--changed-since', 'origin/main');
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /fetch full history/);
    assert.equal(migrations(root, '--changed-since=--output=x').code, 2);

    write(root, NEW_MIGRATION, "SET lock_timeout = '5s';\nDROP TABLE orders;\n");
    const { code, stdout } = migrations(root, '--changed-since', 'main', '--json');
    assert.equal(code, 1);
    const result = JSON.parse(stdout);
    assert.deepEqual(
      result.findings.map((finding) => [finding.file, finding.ruleId]),
      [[NEW_MIGRATION, 'migration-breaking-drop']],
    );
    assert.equal(result.contextualFindingCount, 1);
  });

  test('--help prints usage and exits 0', (context) => {
    const { code, stdout } = migrations(temporaryProject(context), '--help');
    assert.equal(code, 0);
    assert.match(stdout, /^Usage:\n {2}loadwise perf migrations /);
  });
});
