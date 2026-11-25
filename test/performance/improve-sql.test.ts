import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { ensureLoaded, parseStatements, splitStatements } from '../../lib/performance/sql/pg-parser.js';
import { changedFilesSince } from '../../lib/performance/migrations/enforce.js';
import * as performanceChangedLines from '../../lib/performance/changed-lines.js';
import * as maintainabilityChangedLines from '../../lib/maintainability/changed-lines.js';
import { compareOpenApi } from '../../lib/performance/contracts/openapi.js';

function temporaryRepository(context: TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-improve-sql-')));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  git(directory, 'init', '-q', '-b', 'main');
  return directory;
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function write(root: string, name: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), text);
}

// Windows cannot create a file named with `"`, so the name is staged straight into the index.
function stageUnusualName(root: string, name: string, text: string) {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: text, encoding: 'utf8' });
  git(root, '-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${blob.trim()},${name}`);
}

const statementTexts = (sql: string) => splitStatements(sql).map(({ start, end }) => sql.slice(start, end));

describe('pg statement splitter', () => {
  before(ensureLoaded);

  test('keeps a BEGIN ATOMIC routine body, including CASE ... END, in one statement', () => {
    const routine =
      'CREATE OR REPLACE FUNCTION sign_of(value int) RETURNS int LANGUAGE sql\n' +
      'BEGIN ATOMIC\n  SELECT CASE WHEN value > 0 THEN 1 ELSE 0 END;\n  SELECT 2;\nEND';
    const procedure = 'CREATE PROCEDURE touch() LANGUAGE sql BEGIN ATOMIC UPDATE t SET n = n + 1; END';
    const sql = `${routine};\n${procedure};\nCREATE TABLE t (id int);`;
    assert.deepEqual(statementTexts(sql), [routine, procedure, 'CREATE TABLE t (id int)']);
    const parsed = parseStatements(sql);
    assert.deepEqual(
      parsed.map((statement) => [statement.kind, statement.error]),
      [
        ['CreateFunctionStmt', undefined],
        ['CreateFunctionStmt', undefined],
        ['CreateStmt', undefined],
      ],
    );
  });

  test('a transaction BEGIN ... END still splits at every semicolon', () => {
    const sql = 'BEGIN; CREATE TABLE begin_log (id int); END; SELECT 1;';
    assert.deepEqual(statementTexts(sql), ['BEGIN', 'CREATE TABLE begin_log (id int)', 'END', 'SELECT 1']);
  });

  test('dollar quotes, E strings and nested comments hide their semicolons', () => {
    const sql = "SELECT E'a\\';b', $x$ ; $x$ /* outer /* inner ; */ still ; */; SELECT 2;";
    assert.equal(statementTexts(sql).length, 2);
  });
});

describe('--changed-since migrations', () => {
  test('a renamed and edited migration is enforced under its new path', (context) => {
    const root = temporaryRepository(context);
    const body = Array.from({ length: 20 }, (_, index) => `SELECT ${index};`).join('\n') + '\n';
    write(root, 'migrations/001_old.sql', body);
    write(root, 'migrations/002_kept.sql', 'SELECT 2;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'feature');
    git(root, 'mv', 'migrations/001_old.sql', 'migrations/001_new.sql');
    write(root, 'migrations/001_new.sql', body + 'SELECT 99;\n');
    git(root, 'commit', '-q', '-am', 'rename');

    const changed = [...changedFilesSince('main', root)].map((file) => path.basename(file));
    assert.deepEqual(changed, ['001_new.sql']);
  });

  test('a migration renamed without edits stays unenforced', (context) => {
    const root = temporaryRepository(context);
    write(root, 'migrations/001_old.sql', 'SELECT 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'feature');
    git(root, 'mv', 'migrations/001_old.sql', 'migrations/001_new.sql');
    git(root, 'commit', '-q', '-m', 'rename');

    assert.deepEqual([...changedFilesSince('main', root)], []);
  });
});

describe('changed lines with quoted git paths', () => {
  const unusualName = 'src/we"ird.ts';

  test('performance diff parsing reads C-quoted file headers', () => {
    const directory = path.resolve('project');
    const diff = [
      'diff --git "a/src/we\\"ird.ts" "b/src/we\\"ird.ts"',
      '--- "a/src/we\\"ird.ts"',
      '+++ "b/src/we\\"ird.ts"',
      '@@ -1 +1,2 @@',
      'diff --git "a/caf\\303\\251 x.ts" "b/caf\\303\\251 x.ts"',
      '--- "a/caf\\303\\251 x.ts"',
      '+++ "b/caf\\303\\251 x.ts"\t',
      '@@ -3 +3 @@',
    ].join('\n');
    const changed = performanceChangedLines.parseChangedLines(diff, directory);
    const key = (name: string) => performanceChangedLines.fileKey(path.join(directory, name));
    assert.deepEqual(changed.get(key(unusualName)), [[1, 2]]);
    assert.deepEqual(changed.get(key('café x.ts')), [[3, 3]]);
  });

  test('performance --staged finds a staged file whose name git quotes', (context) => {
    const root = temporaryRepository(context);
    write(root, 'plain.ts', 'export const plain = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    stageUnusualName(root, unusualName, 'export const one = 1;\nexport const two = 2;\n');

    const changed = performanceChangedLines.collectChangedLines({ staged: true }, root);
    const key = performanceChangedLines.fileKey(path.join(root, unusualName));
    assert.deepEqual([...changed.keys()], [key]);
    assert.deepEqual(changed.get(key), [[1, 2]]);
  });

  test('maintainability --staged finds a staged file whose name git quotes', (context) => {
    const root = temporaryRepository(context);
    write(root, 'plain.js', 'module.exports = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    stageUnusualName(root, unusualName, 'export const one = 1;\nexport const two = 2;\n');

    const changes = maintainabilityChangedLines.readChangedRanges(root, { staged: true });
    assert.deepEqual([...changes.entries()], [[unusualName, [[1, Infinity]]]]);
  });

  test('maintainability diff parsing reads C-quoted headers and keeps plain ones', () => {
    const diff = [
      'diff --git "a/tab\\there.js" "b/tab\\there.js"',
      '--- "a/tab\\there.js"',
      '+++ "b/tab\\there.js"',
      '@@ -2 +2,3 @@',
      'diff --git a/plain name.js b/plain name.js',
      '--- a/plain name.js',
      '+++ b/plain name.js\t',
      '@@ -1 +1 @@',
    ].join('\n');
    const changes = maintainabilityChangedLines.parseChangedRanges(diff);
    assert.deepEqual(changes.get('tab\there.js'), [[2, 4]]);
    assert.deepEqual(changes.get('plain name.js'), [[1, 1]]);
  });
});

describe('OpenAPI numeric widening and narrowing', () => {
  interface DocumentTypes {
    requestType: string;
    responseType: string;
    parameterType: string;
  }

  function documentWith({ requestType, responseType, parameterType }: DocumentTypes) {
    return JSON.stringify({
      openapi: '3.0.0',
      paths: {
        '/items': {
          post: {
            parameters: [{ in: 'query', name: 'limit', schema: { type: parameterType } }],
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { price: { type: requestType } } },
                },
              },
            },
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { total: { type: responseType } } },
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  test('widening a request integer to number and narrowing a response number to integer are not breaking', () => {
    const findings = compareOpenApi(
      documentWith({ requestType: 'integer', responseType: 'number', parameterType: 'integer' }),
      documentWith({ requestType: 'number', responseType: 'integer', parameterType: 'number' }),
    );
    assert.deepEqual(findings, []);
  });

  test('narrowing a request number to integer and widening a response integer to number still break', () => {
    const findings = compareOpenApi(
      documentWith({ requestType: 'number', responseType: 'integer', parameterType: 'number' }),
      documentWith({ requestType: 'integer', responseType: 'number', parameterType: 'integer' }),
    );
    assert.deepEqual(
      findings.map((finding) => finding.ruleId),
      ['api-type-changed', 'api-type-changed', 'api-type-changed'],
    );
  });
});
