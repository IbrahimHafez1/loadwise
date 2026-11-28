import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lint } from './helpers.js';

const rule = 'llm-call-without-max-tokens';
const files = {
  'node_modules/openai/index.d.ts': `
    export interface Options { model: string; max_tokens?: number; max_completion_tokens?: number; max_output_tokens?: number }
    export class Completions { create(options: Options): Promise<{}> }
    export class Responses { create(options: Options): Promise<{}> }
    export default class OpenAI {
      constructor(options?: {});
      chat: { completions: Completions };
      responses: Responses;
    }`,
};
const header = "import OpenAI from 'openai';\ndeclare const client: OpenAI;\n";

test('reports OpenAI chat and responses calls without an output cap', () => {
  const findings = lint(
    header + ["client.chat.completions.create({ model: 'm' });", "client.responses.create({ model: 'm' });"].join('\n'),
    files,
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [3, 4].map((line) => [rule, line]),
  );
});

test('calls with a cap, unknown options or another receiver stay quiet', () => {
  assert.deepEqual(
    lint(
      header +
        [
          "client.chat.completions.create({ model: 'm', max_tokens: 10 });",
          "client.chat.completions.create({ model: 'm', max_completion_tokens: 10 });",
          "client.responses.create({ model: 'm', max_output_tokens: 10 });",
          'declare const shared: { model: string };',
          'client.responses.create(shared);',
          'client.responses.create({ ...shared });',
          'declare const other: { chat: { completions: { create(o: {}): void } } };',
          "other.chat.completions.create({ model: 'm' });",
        ].join('\n'),
      files,
    ),
    [],
  );
});

test('a cap set to undefined or null still reports, and the legacy completions resource stays quiet', () => {
  const legacyFiles = {
    'node_modules/openai/index.d.ts': files['node_modules/openai/index.d.ts'].replace(
      'responses: Responses;',
      'responses: Responses; completions: Completions;',
    ),
  };
  const findings = lint(
    header +
      [
        "client.chat.completions.create({ model: 'm', max_tokens: undefined });",
        "client.responses.create({ model: 'm', max_output_tokens: void 0 });",
        "client.completions.create({ model: 'm' });",
      ].join('\n'),
    legacyFiles,
  );
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [3, 4].map((line) => [rule, line]),
  );
});
