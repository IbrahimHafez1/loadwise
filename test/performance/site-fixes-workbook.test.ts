import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import ts from 'typescript';
import { applyChangesToText } from '../../editor/apply-fix.cjs';
import { scanWithFixes } from './site-fix-helpers.js';
import { fixOf, requireText } from '../types/finding-fix.js';

// The members of the compiled fixture class the test calls.
interface WorkbookReader {
  run(file: { buffer: Uint8Array }): Promise<string[]>;
  first(file: { buffer: Uint8Array }): Promise<string>;
}

function reader(method: string, sheet: string, extra = '') {
  return `private async ${method}(file: Upload) {
    try {
      const Excel = await import('exceljs');
      const book = new Excel.Workbook();
      await book.xlsx.load(file.buffer);
      const result = book.getWorksheet('${sheet}');
      ${extra}
      return result.name;
    } catch {
      return 'fallback';
    }
  }`;
}

function program(secondSheet = 'Orders', extra = '') {
  return `type Upload = { buffer: Uint8Array };
export class Reader {
  ${reader('first', 'Users')}
  ${reader('second', secondSheet, extra)}
  async run(file: Upload) {
    const first = await this.first(file);
    const second = await this.second(file);
    return [first, second];
  }
}`;
}

function findings(context: TestContext, source: string) {
  return scanWithFixes(context, {
    'app.ts': source,
    'node_modules/exceljs/package.json':
      '{"name":"exceljs","main":"index.js","types":"index.d.ts","exports":{".":{"types":"./index.d.ts","default":"./index.js"}}}',
    'node_modules/exceljs/index.d.ts':
      'export class Workbook { xlsx: { load(bytes: Uint8Array): Promise<void> }; getWorksheet(name: string): { name: string } }',
  }).findings.filter(({ ruleId }) => ruleId === 'repeated-workbook-decode');
}

test('shared workbook edit keeps catches, retries failed loads, and has invocation-local lifetime', async (context) => {
  const source = program();
  const [finding] = findings(context, source);
  assert.equal(fixOf(finding).requiresReview, true);
  const updated = requireText(applyChangesToText(source, fixOf(finding).changes).text);
  assert.deepEqual(findings(context, updated), []);

  let count = 0;
  let failNext = false;
  class Workbook {
    xlsx = {
      load: async () => {
        count++;
        if (failNext) {
          failNext = false;
          throw new Error('Invalid workbook');
        }
      },
    };
    getWorksheet(name: string) {
      return { name };
    }
  }
  const compiled = ts.transpileModule(updated, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const imported: { Reader?: new () => WorkbookReader } = {};
  new Function('exports', 'require', compiled)(imported, () => ({ Workbook }));
  const { Reader } = imported;
  assert.ok(Reader, 'the compiled module exports Reader');
  const instance = new Reader();
  const file = { buffer: new Uint8Array() };
  assert.deepEqual(await instance.run(file), ['Users', 'Orders']);
  assert.equal(count, 1);
  failNext = true;
  assert.deepEqual(await instance.run(file), ['fallback', 'Orders']);
  assert.equal(count, 3);
  assert.equal(await instance.first(file), 'Users');
  assert.equal(count, 4);
});

test('shared worksheet, worksheet mutation and dynamic constructor withhold the edit', (context) => {
  for (const source of [
    program('Users'),
    program('Orders', "result.name = 'changed';"),
    program()
      .replaceAll('const Excel = await import', 'const other = 1; const Excel = await import')
      .replaceAll('new Excel.Workbook()', 'new (Excel.Workbook)()'),
  ]) {
    const [finding] = findings(context, source);
    assert.ok(finding);
    assert.equal(finding.fix, undefined);
  }
});
