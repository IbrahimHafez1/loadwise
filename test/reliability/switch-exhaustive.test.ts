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
