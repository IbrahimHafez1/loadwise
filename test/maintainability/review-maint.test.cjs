'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { checkSizeLimits } = require('../../lib/maintainability/size-limits.cjs');
const { scan } = require('../../lib/maintainability/scan.cjs');

const policy = { exclude: [], boundaries: [], placement: [] };

async function unusedModuleFindings(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-review-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), text);
    }
    const report = await scan(root, policy);
    return report.findings
      .filter((finding) => /^unused-export$|^unreferenced-file$/.test(finding.ruleId))
      .map((finding) => `${finding.ruleId} ${finding.file}`)
      .sort();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('large-module counts a data module whose one array holds hundreds of thousands of entries', () => {
  const entryCount = 200000;
  const entries = Array.from({ length: entryCount }, (_, index) => `  "word${index}",`);
  const source = ['module.exports = [', ...entries, '];'].join('\n');
  const file = 'src/words.js';
  const findings = checkSizeLimits(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), file);
  assert.deepEqual(
    findings.map((finding) => finding.ruleId),
    ['large-module'],
  );
  assert.match(findings[0].message, new RegExp(`${entryCount + 2} lines of code`));
});

test('a Node worker started from a path beside the current file references that file', async () => {
  const findings = await unusedModuleFindings({
    'package.json': '{"main":"src/app/index.js"}',
    'src/app/index.js': [
      "const path = require('node:path');",
      "const { Worker } = require('node:worker_threads');",
      "new Worker(path.join(__dirname, 'job.js'));",
      "new Worker(path.resolve(__dirname, 'workers', 'nested.js'), { workerData: 1 });",
      "new Worker(path.join(__dirname, '..', 'outside.js'));",
      "new Worker(path.join(configuredFolder, 'elsewhere.js'));",
      'new Worker(path.join(__dirname, name));',
    ].join('\n'),
    'src/app/job.js': "module.exports.unused = 1;\nconsole.log('job');",
    'src/app/workers/nested.js': "console.log('nested');",
    'src/outside.js': "console.log('outside');",
    'src/app/elsewhere.js': "console.log('elsewhere');",
  });
  assert.deepEqual(findings, ['unreferenced-file src/app/elsewhere.js']);
});
