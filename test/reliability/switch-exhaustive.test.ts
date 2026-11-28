import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSwitchExhaustive } from '../../lib/reliability/switch-exhaustive.js';
import { withProgram } from '../performance/helpers.js';
import type { Finding } from '../../lib/shared/types.js';

function scan(source: string): Finding[] {
  return withProgram(source, {}, (program, sourceFile) =>
    checkSwitchExhaustive(sourceFile, 'main.ts', program.getTypeChecker()),
  );
}

function lines(...rows: string[]): string {
  return rows.join('\n') + '\n';
}

test('switch-not-exhaustive reports a missing literal when the function ends without returning', () => {
  const [finding] = scan(
    lines(
      "type Mode = 'a' | 'b' | 'c';",
      'export function label(mode: Mode) {',
      '  switch (mode) {',
      "    case 'a':",
      "      return 'A';",
      "    case 'b':",
      "      return 'B';",
      '  }',
      '}',
    ),
  );
  assert.equal(finding.ruleId, 'switch-not-exhaustive');
  assert.equal(finding.line, 3);
  assert.match(finding.message, /"c"/);
});

test('switch-not-exhaustive reports a missing enum member and an unset variable', () => {
  const source = lines(
    'enum Color { Red, Green, Blue }',
    'export function hex(color: Color): string {',
    '  let value: string;',
    '  switch (color) {',
    '    case Color.Red:',
    "      value = 'f00';",
    '      break;',
    '    case Color.Green:',
    "      value = '0f0';",
    '      break;',
    '  }',
    '  return value!;',
    '}',
  );
  assert.deepEqual(
    scan(source).map(({ ruleId }) => ruleId),
    ['switch-not-exhaustive'],
  );
});

test('switch-not-exhaustive stays quiet when the switch is complete or the gap is harmless', () => {
  const quiet = [
    "type M = 'a' | 'b';\nexport function f(m: M) { switch (m) { case 'a': return 1; case 'b': return 2; } }",
    "type M = 'a' | 'b';\nexport function f(m: M) { switch (m) { case 'a': return 1; default: return 2; } }",
    "type M = 'a' | 'b';\nexport function f(m: M) { switch (m) { case 'a': case 'b': return 1; } }",
    "type M = 'a' | 'b' | 'c';\nexport function f(m: M) { switch (m) { case 'a': console.log(m); break; } }",
    "type M = 'a' | 'b' | 'c';\nexport function f(m: M) { switch (m) { case 'a': return 1; } return 0; }",
    "export function f(m: string) { switch (m) { case 'a': return 1; case 'b': return 2; } }",
    "type M = 'a' | 'b';\nexport function f(m: M, other: M) { switch (m) { case other: return 1; } }",
    "type M = 'a' | 'b' | 'c';\nexport function f(m: M) { let v = 0; switch (m) { case 'a': v = 1; break; } return v; }",
  ];
  for (const source of quiet) assert.deepEqual(scan(source), [], source);
});

test('switch-not-exhaustive stays quiet when the unset case is typed as undefined or the function returns nothing', () => {
  const quiet = [
    "type M = 'a' | 'b' | 'c';\nexport function f(m: M) { let v: string | undefined; switch (m) { case 'a': v = 'x'; break; } return v; }",
    "type M = 'a' | 'b' | 'c';\nasync function g(): Promise<void> {}\nexport async function f(m: M) { switch (m) { case 'a': return g(); case 'b': return; } }",
  ];
  for (const source of quiet) assert.deepEqual(scan(source), [], source);
});

test('switch-not-exhaustive matches variables by binding, not by name', () => {
  const quiet = [
    "type M = 'a' | 'b' | 'c';\nexport function f(m: M) { let value = 0; switch (m) { case 'a': value = 1; break; } function unused() { let value: string; return value; } return value; }",
    "type M = 'a' | 'b' | 'c';\nexport function f(m: M, box: { value: number }) { let value: number; switch (m) { case 'a': value = 1; break; } return box.value; }",
  ];
  for (const source of quiet) assert.deepEqual(scan(source), [], source);
});

test('switch-not-exhaustive accepts an assignment outside the switch and reports a definite-assignment variable', () => {
  const quiet = [
    "type M = 'a' | 'b' | 'c';\nexport function f(m: M) { let value: number; value = 0; switch (m) { case 'a': value = 1; break; } return value; }",
    "type M = 'a' | 'b' | 'c';\nexport function f(m: M) { let value: number; switch (m) { case 'a': value = 1; break; } value = 2; return value; }",
  ];
  for (const source of quiet) assert.deepEqual(scan(source), [], source);
  const reported = [
    "type M = 'a' | 'b' | 'c';\nexport function f(m: M, ready: boolean) { let value: number; if (ready) value = 0; switch (m) { case 'a': value = 1; break; } return value; }",
    "type M = 'a' | 'b' | null;\nexport function f(m: M) { switch (m) { case null: return 0; case 'a': return 1; } }",
    "type M = 'a' | 'b' | undefined;\nexport function f(m: M) { switch (m) { case undefined: return 0; case 'a': return 1; } }",
    "type M = 'a' | 'b';\nexport function f(m: M) { let value: number; switch (m) { case 'a': value = 1; break; } if (value > 0) return 1; return 0; }",
    "type M = 'a' | 'b' | 'c';\nexport function f(m: M) { let value: number; const init = () => { value = 0; }; switch (m) { case 'a': value = 1; break; } return value; }",
    "type M = 'a' | 'b' | 'c';\nexport function f(m: M) { let value!: number; switch (m) { case 'a': value = 1; break; } return value; }",
    "type M = 'a' | 'b' | 'c';\nexport function f(m: M) { let value: number; switch (m) { case 'a': [value] = [1]; break; } return value; }",
    "type M = 'a' | 'b' | 'c';\nexport function f(m: M) { let value: number; switch (m) { case 'a': ({ value } = { value: 1 }); break; } return value; }",
  ];
  for (const source of reported) assert.equal(scan(source)[0]?.ruleId, 'switch-not-exhaustive', source);
});

test('switch-not-exhaustive reaches switches nested in final blocks, counts null and ignores never returns', () => {
  const reported = [
    "type M = 'a' | 'b' | 'c';\nexport function f(m: M, ok: boolean) { if (ok) { switch (m) { case 'a': return 1; case 'b': return 2; } } else { return 0; } }",
    "type M = 'a' | 'b' | 'c';\nexport function f(m: M) { try { switch (m) { case 'a': return 1; case 'b': return 2; } } finally { console.log(m); } }",
    "type M = 'a' | 'b' | 'c';\nexport function f(m: M) { switch (m) { case 'a': return null; case 'b': return null; } }",
  ];
  for (const source of reported) assert.equal(scan(source)[0]?.ruleId, 'switch-not-exhaustive', source);
  const quietTail = [
    "type M = 'a' | 'b';\nexport function f(m: M) { let value: number; switch (m) { case 'a': value = 1; break; } const fallback: typeof value = 0; return fallback; }",
    "type M = 'a' | 'b';\nexport function f(m: M) { try { switch (m) { case 'a': return 1; } } finally { return 0; } }",
    "type M = 'a' | 'b';\nexport function f(m: M) { try { switch (m) { case 'a': return 1; } } finally { throw new Error('x'); } }",
    "type M = 'a' | 'b';\nexport function f(m: M) { let value: number; switch (m) { case 'a': value = 1; break; } return m === 'a' ? value : 0; }",
  ];
  for (const source of quietTail) assert.deepEqual(scan(source), [], source);
  const promiseSource =
    "type M = 'a' | 'b';\nexport function f(m: M) { switch (m) { case 'a': return Promise.resolve(); } }";
  assert.equal(scan(promiseSource)[0]?.ruleId, 'switch-not-exhaustive', promiseSource);
  const quiet =
    "type M = 'a' | 'b' | 'c';\ndeclare function fail(): never;\nexport function f(m: M) { switch (m) { case 'a': return fail(); case 'b': return fail(); } }";
  assert.deepEqual(scan(quiet), [], quiet);
});

test('switch-not-exhaustive skips unknown variables, declaration names and reads through shorthand properties', () => {
  const head = "type M = 'a' | 'b';\nexport function f(m: M) {";
  const quiet = [
    `${head} let value: unknown; switch (m) { case 'a': value = 1; break; } return value; }`,
    `${head} switch (m) { case 'a': value = 1; break; } var value: number; return 0; }`,
  ];
  for (const source of quiet) assert.deepEqual(scan(source), [], source);
  const reported = [
    `${head} let value: number; switch (m) { case 'a': value = 1; break; } return { value }; }`,
    `${head} let value: number; switch (m) { case 'a': value = 1; break; } return value; }`,
  ];
  for (const source of reported) assert.equal(scan(source)[0]?.ruleId, 'switch-not-exhaustive', source);
});
