'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { formatFinding } = require('../lib/editor-report.cjs');

function fixture(context, filename, source) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'checker-editor-report-'));
  const file = path.join(root, filename);
  fs.writeFileSync(file, source);
  context.after(() => {
    fs.unlinkSync(file);
    fs.rmdirSync(root);
  });
  return root;
}

test('formats a full-word marker with a site-specific replacement and escapes untrusted input', (context) => {
  const source = 'return ids.every(id => allowed.includes(id));';
  const file = 'list.ts';
  const root = fixture(context, file, '\uFEFF' + source);
  const column = source.indexOf('includes') + 1;
  const report = formatFinding(root, 'backend-perf-check', {
    file,
    line: 1,
    column,
    ruleId: 'array-repeated-membership',
    message: 'Repeated search.\r\nBACKEND_CHECKER\tforged\u2028line\u001b[31m',
  });
  assert.ok(
    report.startsWith(
      ['BACKEND_CHECKER', file, 1, column, column + 'includes'.length, 'warning', 'array-repeated-membership'].join(
        ' | ',
      ),
    ),
  );
  assert.doesNotMatch(report, /\p{Cc}/u);
  assert.match(report, /forged line/);
  assert.match(report, /allowed\.includes\(id\) → allowedSet\.has\(id\)/);
  assert.ok(report.includes('Current code:\u2028' + source + '\u2028Suggested rewrite:'));
  assert.match(report, /const allowedSet = new globalThis.Set\(allowed\);/);
});

test('keeps Python example indentation, converts parser columns and reads each finding file once', (context) => {
  const source = '"""😀"""; eligible = True';
  const file = 'demo.py';
  const root = fixture(context, file, source);
  const cache = new Map();
  const finding = {
    file,
    line: 1,
    column: Array.from('"""😀"""; ').length + 1,
    ruleId: 'deep-control-flow',
    message: 'Review nesting.',
  };
  const report = formatFinding(root, 'maintainability-check', finding, cache);
  const column = source.indexOf('eligible') + 1;
  assert.ok(report.startsWith(['BACKEND_CHECKER', file, 1, column, column + 'eligible'.length].join(' | ')));
  assert.match(report, /\u2028    if not /);
  assert.ok(report.includes('Flagged line:\u2028' + source + '\u2028Illustrative alternative:'));
  fs.writeFileSync(path.join(root, file), '');
  assert.equal(formatFinding(root, 'maintainability-check', finding, cache), report);
  for (const invalid of [
    { line: -1 },
    { column: NaN },
    { line: 30 },
    { file: '../else.py' },
    { file: 'a\nb.py' },
    { ruleId: 'fake\nmessage' },
  ]) {
    assert.equal(formatFinding(root, 'maintainability-check', { ...finding, ...invalid }, cache), undefined);
  }
});

test('puts the scanner action on the first line when no exact rewrite is justified', (context) => {
  const file = 'service.ts';
  const root = fixture(context, file, 'function fulfillOrder() {}');
  const finding = {
    file,
    line: 1,
    column: 10,
    ruleId: 'high-branch-complexity',
    message: 'Branch complexity is 16.',
    suggestion: 'Extract the per-iteration work at lines 4–12. Preserve the early exit.',
  };
  const report = formatFinding(root, 'maintainability-check', finding);
  assert.ok(report.includes(' | Review: ' + finding.suggestion + '\u2028' + finding.message));
  assert.ok(report.includes('Flagged line:\u2028function fulfillOrder() {}'));
  assert.doesNotMatch(report, /Illustrative alternative|handlers =/);
});

test('retains an inline action for long query examples and the actual selected columns', (context) => {
  const file = 'repo.ts';
  const root = fixture(context, file, 'await this.repository.find({ where });');
  const finding = {
    file,
    line: 1,
    column: 23,
    ruleId: 'orm-query-in-loop',
    message:
      'TypeORM.find() can execute a database operation per item. For independent reads, consider fetching the keys together.',
  };
  const report = formatFinding(root, 'backend-perf-check', finding);
  assert.match(report, / \| Review: [^\u2028]+\u2028TypeORM\.find/);
  const projection = formatFinding(root, 'backend-perf-check', {
    ...finding,
    ruleId: 'typeorm-wide-projection',
    message: 'Consider select: { title: true, id: true } to avoid loading unused wide columns (body).',
  });
  assert.match(projection, / \| Consider select: \{ title: true, id: true \} after checking subscribers\./);
});
