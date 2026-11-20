'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { analyzePolyglot } = require('../../lib/maintainability/polyglot.cjs');
const { duplicateRule } = require('../../lib/maintainability/polyglot-duplicates.cjs');

let available = false;
try {
  available = Boolean(require('@ast-grep/cli/postinstall.js').resolveBinaryPath());
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
const nativeOnly = { skip: !available && 'Optional parser is unavailable' };

const fixtures = {
  Python: [
    'py',
    (name) => `def ${name}(values):
    score = 0
    for value in values:
        if value < 0:
            continue
        score += value * 3
    return score
`,
  ],
  Go: [
    'go',
    (name) => `package sample
func ${name}(values []int) int {
    score := 0
    for _, value := range values {
        if value < 0 { continue }
        score += value * 3
    }
    return score
}
`,
  ],
  Java: [
    'java',
    (name) => `class Sample {
  int ${name}(int[] values) {
    int score = 0;
    for (int value : values) {
        if (value < 0) continue;
        score += value * 3;
    }
    return score;
  }
}
`,
  ],
  'C#': [
    'cs',
    (name) => `class Sample {
  int ${name}(int[] values) {
    int score = 0;
    foreach (int value in values) {
        if (value < 0) continue;
        score += value * 3;
    }
    return score;
  }
}
`,
  ],
  Rust: [
    'rs',
    (name) => `fn ${name}(values: &[i32]) -> i32 {
    let mut score = 0;
    for value in values {
        if *value < 0 { continue; }
        score += value * 3;
    }
    return score;
}
`,
  ],
};

function temporaryFiles(context, contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintainability-duplicate-body-'));
  const files = Object.keys(contents);
  context.after(() => {
    for (const file of files) fs.unlinkSync(path.join(root, file));
    fs.rmdirSync(root);
  });
  for (const [file, value] of Object.entries(contents)) fs.writeFileSync(path.join(root, file), value);
  return { root, files };
}

for (const [language, [extension, source]] of Object.entries(fixtures)) {
  test(
    language + ' groups exact substantial bodies and preserves literal and spacing differences',
    nativeOnly,
    async (context) => {
      const options = temporaryFiles(context, {
        ['b.' + extension]: source('second'),
        ['a.' + extension]: source('first'),
        ['literal.' + extension]: source('changed').replace('value * 3', 'value * 4'),
        ['spacing.' + extension]: source('other').replace('value * 3', 'value  * 3'),
      });
      const { findings } = await analyzePolyglot(options);
      assert.deepEqual(
        findings.map((row) => [row.ruleId, row.file, row.related.map((site) => site.file)]),
        [['duplicate-implementation', 'a.' + extension, ['b.' + extension]]],
      );
      assert.ok(findings[0].line > 0 && findings[0].column > 0);
      assert.ok(!findings[0].message.includes('score'));
      assert.match(findings[0].message, /extract one shared function/);
    },
  );
}

test('wrappers, literal data and oversized bodies do not create duplicate diagnostics', nativeOnly, async (context) => {
  const wrapper = 'def NAME(value):\n    return normalize(value)\n';
  const fixture =
    'def NAME():\n    options = {\n        "origin": 42,\n        "label": "sample",\n        "scale": 3,\n    }\n    return options\n';
  const long = fixtures.Python[1]('NAME').replace('score = 0', 'score = 0  # ' + 'x'.repeat(8000));
  const { findings } = await analyzePolyglot(
    temporaryFiles(context, {
      'a.py': [wrapper, fixture, long].map((source, index) => source.replace('NAME', 'first' + index)).join('\n'),
      'b.py': [wrapper, fixture, long].map((source, index) => source.replace('NAME', 'second' + index)).join('\n'),
    }),
  );
  assert.deepEqual(findings, []);
  assert.equal(duplicateRule('Ruby'), undefined);
});
