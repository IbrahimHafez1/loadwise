// How a finding becomes contextual: a reviewed comment, a test or example source, or a reason the
// rule passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import { createAnalyzer } from '../../lib/security/analyze.cjs';
import { createFileContext } from '../../lib/security/file-context.cjs';
import { withProgram } from '../performance/helpers.cjs';
import type { CallExpression, Node, SourceFile } from 'typescript';
import type { ProgramAdapter, SecurityRuleContext } from '../../lib/shared/types.cjs';

// Reports every call to probe() under the given rule id, with the rule's own reason when the call
// has an argument.
function probeModule(ruleId: string) {
  return {
    checks: {
      CallExpression: [
        (call: CallExpression, context: SecurityRuleContext) => {
          if (call.expression.getText(context.sourceFile) !== 'probe') return;
          context.report(call, ruleId, 'Probe finding.', call.arguments.length ? 'Rule reason.' : undefined);
        },
      ],
    },
  };
}

function findings(source: string, ruleId = 'probe-rule') {
  return withProgram(source, {}, (program: ProgramAdapter, sourceFile: SourceFile) =>
    createAnalyzer([probeModule(ruleId)])(program, sourceFile),
  );
}

test('a reviewed comment on the line above makes a finding contextual, except for protected scope rules', () => {
  const source = [
    'declare function probe(...values: unknown[]): void;',
    '// loadwise-reviewed probe-rule -- the input is a fixed list',
    'probe();',
    'probe();',
    'probe(1);',
  ].join('\n');
  assert.deepEqual(
    findings(source).map(({ line, contextualReason }) => [line, contextualReason]),
    [
      [3, 'Reviewed in source: the input is a fixed list'],
      [4, undefined],
      [5, 'Rule reason.'],
    ],
  );
  const protectedSource = source.replace('probe-rule', 'prisma-scope-unverified');
  assert.equal(findings(protectedSource, 'prisma-scope-unverified')[0].contextualReason, undefined);
});

test('one finding per node and rule, in source order', () => {
  const twice = { checks: { CallExpression: [...probeModule('probe-rule').checks.CallExpression] } };
  const result = withProgram(
    'declare function probe(): void;\nprobe();',
    {},
    (program: ProgramAdapter, sourceFile: SourceFile) =>
      createAnalyzer([twice, probeModule('probe-rule')])(program, sourceFile),
  );
  assert.equal(result.length, 1);
  assert.throws(
    () => createAnalyzer([{ checks: { NotAKind: [] } }]),
    /Unknown syntax kind in security checks: NotAKind/,
  );
});

test('tests, fixtures, mocks, examples and stories are test or example sources', () => {
  const contextOf = (file: string) =>
    createFileContext(ts.createSourceFile(path.resolve(file), '', ts.ScriptTarget.ES2022));
  for (const file of [
    'src/orders.test.ts',
    'test/orders.ts',
    'src/__fixtures__/orders.ts',
    'src/mocks/orders.ts',
    'examples/orders.ts',
    'src/Button.stories.tsx',
  ]) {
    assert.equal(contextOf(file).testSourceReason, 'Test or example source.', file);
  }
  assert.equal(contextOf('src/orders.ts').isTestSource, false);
});

test('a non-production guard covers only its then branch', () => {
  const source = [
    'declare function probe(): void;',
    "if (process.env.NODE_ENV !== 'production') probe(); else probe();",
    'if (isDev) { probe(); }',
    'probe();',
  ].join('\n');
  const guarded = withProgram(
    `declare const process: any, isDev: boolean;\n${source}`,
    {},
    (program: ProgramAdapter, sourceFile: SourceFile) => {
      const results: boolean[] = [];
      const { underNonProductionGuard } = createFileContext(sourceFile);
      (function visit(node: Node): void {
        if (ts.isCallExpression(node)) results.push(underNonProductionGuard(node));
        ts.forEachChild(node, visit);
      })(sourceFile);
      return results;
    },
  );
  assert.deepEqual(guarded, [true, false, true, false]);
});
