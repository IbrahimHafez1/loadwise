'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { checkPlacement } = require('../../lib/maintainability/layout.cjs');

test('placement checks have no defaults and use caller-defined suffixes for any language', () => {
  const files = [
    'service/web/admin.controller.ts',
    'tests/unit/import_test.go',
    'source/users/query_repo.py',
    'notes.md',
  ];
  assert.deepEqual(checkPlacement(files), []);
  assert.deepEqual(
    checkPlacement(files, [
      { suffix: '.controller.ts', under: ['service/web'] },
      { suffix: '_test.go', under: ['spec', 'tests'] },
      { suffix: '_repo.py', under: ['source/users'] },
    ]),
    [],
  );
});

test('placement respects directory boundaries, separator styles and case-sensitive file names', () => {
  const findings = checkPlacement(
    [
      'src/http/v1/admin.controller.ts',
      'src/httpish/admin.controller.ts',
      'src/HTTP/admin.controller.ts',
      'app\\handlers\\admin.controller.ts',
      'src/admin.Controller.ts',
      'tools.controller.ts/entry.ts',
    ],
    [{ suffix: '.controller.ts', under: ['./src/http/', 'app\\handlers'] }],
  );
  assert.deepEqual(
    findings.map(({ file, line, column, ruleId }) => [file, line, column, ruleId]),
    [
      ['src/httpish/admin.controller.ts', 1, 1, 'file-placement'],
      ['src/HTTP/admin.controller.ts', 1, 1, 'file-placement'],
    ],
  );
  assert.match(findings[0].message, /\.controller\.ts/);
  assert.match(findings[0].message, /src\/http/);
  assert.match(findings[0].message, /Move this file there/);
});

test('a specific suffix overrides a broad suffix regardless of configuration order', () => {
  const general = { suffix: '.go', under: ['internal'] };
  const specific = { suffix: '_test.go', under: ['test'] };
  const files = ['internal/orders.go', 'test/orders_test.go', 'internal/orders_test.go', 'test/orders.go'];
  for (const rules of [
    [general, specific],
    [specific, general],
  ]) {
    assert.deepEqual(
      checkPlacement(files, rules).map((finding) => finding.file),
      files.slice(2),
    );
  }
});

test('invalid placement declarations fail even when the inventory is empty', () => {
  for (const rules of [
    {},
    [null],
    [{}],
    [{ suffix: '', under: ['src'] }],
    [{ suffix: 'path/file.py', under: ['src'] }],
    [{ suffix: 'x', under: [] }],
    [{ suffix: 'x', under: 'src' }],
    [{ suffix: 'x', under: [''] }],
    [{ suffix: 'x', under: ['../outside'] }],
    [{ suffix: 'x', under: ['/absolute'] }],
    [{ suffix: 'x', under: ['C:\\outside'] }],
    [
      { suffix: 'x', under: ['src'] },
      { suffix: 'x', under: ['elsewhere'] },
    ],
  ]) {
    assert.throws(() => checkPlacement([], rules), /placement/i);
  }
});
