'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildFix, createFileCache } = require('../../lib/maintainability/site-fix.cjs');

function project(context) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'loadwise-review-maint-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  return directory;
}

const record = [
  'interface Packet {',
  '  when: Date;',
  ...Array.from({ length: 20 }, (_, index) => `  field${index}: Array<string | null>;`),
  '}',
].join('\n');

test('a record that is re-exported by name stays in its module', (context) => {
  const directory = project(context);
  const finding = { file: 'api.ts', line: 1, column: 1, ruleId: 'large-module', id: 'packet' };
  const source = `${record}\nexport function inspect(packet: Packet) { return packet.when; }\n`;
  fs.writeFileSync(path.join(directory, 'api.ts'), source);
  assert.ok(buildFix(finding, createFileCache(directory)));
  for (const reExport of ['export { Packet };\n', 'export type { Packet };\n', 'export default Packet;\n']) {
    fs.writeFileSync(path.join(directory, 'api.ts'), source + reExport);
    assert.equal(buildFix(finding, createFileCache(directory)), undefined, reExport);
  }
});

test('a class extending an import keeps it a value import', (context) => {
  const directory = project(context);
  const text = "import { Base } from './base';\nexport class Child extends Base {}\n";
  fs.writeFileSync(path.join(directory, 'child.ts'), text);
  fs.writeFileSync(
    path.join(directory, 'base.ts'),
    "import { Child } from './child';\nexport class Base { kid?: Child }\n",
  );
  const finding = {
    file: 'child.ts',
    line: 1,
    column: text.indexOf("'./base'") + 1,
    ruleId: 'dependency-cycle',
    id: 'cycle',
  };
  assert.equal(buildFix(finding, createFileCache(directory)), undefined);
  const implemented = "import { Base } from './base';\nexport class Child implements Base {}\n";
  fs.writeFileSync(path.join(directory, 'child.ts'), implemented);
  const fix = buildFix(finding, createFileCache(directory));
  assert.equal(fix.changes[0].after, "import type { Base } from './base';");
});
