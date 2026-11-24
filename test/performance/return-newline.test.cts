import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.cjs';

function reported(source: string) {
  return lint(source).filter(({ ruleId }) => ruleId === 'return-newline');
}

test('a newline can turn a return value into a separate expression or labeled block', () => {
  const findings = reported(`function parenthesized() {
  return
  ({ ok: true });
}
function labeledBlock() {
  return
  { error: 'Unavailable' }
}
function parenthesizedName(result: string) {
  return
  (result);
}`);
  assert.deepEqual(
    findings.map(({ line, column }) => [line, column]),
    [
      [2, 3],
      [6, 3],
      [10, 3],
    ],
  );
  assert.match(findings[0].message, /newline.*return.*undefined/i);
});

test('intentional bare returns, ordinary unreachable code, and returns with a value are quiet', () => {
  assert.deepEqual(
    reported(`declare function doWork(): void;
declare const ready: boolean;
function explicit() {
  return;
  ({ ok: true });
}
function sameLine() {
  return (
    { ok: true }
  );
}
function ordinaryCall() {
  return
  doWork();
}
function parenthesizedCall() {
  return
  (doWork());
}
function unrelatedBlock() {
  return
  { doWork(); }
}
function labeledWork() {
  return
  { reset: doWork(); }
}
function intentionalLabel() {
  return
  { example: 'value'; }
}
function intentionalComment() {
  return // Skip this branch.
  ({ ok: true });
}
function separateStatement() {
  return

  ({ ok: true });
}
function singleStatementBody() {
  if (ready) return
  ({ ok: true });
}
function bare() {
  return
}`),
    [],
  );
});
