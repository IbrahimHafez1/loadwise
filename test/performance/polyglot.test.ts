import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { checkPolyglot } from '../../lib/performance/polyglot.js';
import { fileOf } from '../types/finding-fix.js';
import { resolveBinaryPath } from '@ast-grep/cli/postinstall.js';

let nativeAvailable = false;
try {
  nativeAvailable = Boolean(resolveBinaryPath());
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND')) throw error;
}
const nativeOnly = { skip: nativeAvailable ? false : 'optional ast-grep native binary is absent' };

function fixture(context: TestContext, files: Record<string, string | Buffer>) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'perfcheck polyglot '));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content);
  context.after(() => {
    for (const name of Object.keys(files)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  return directory;
}

const samples = {
  'items.py': `def collect(values):
    result = []
    for item in values:
        result = result + [item]
    return result

def append(values):
    result = []
    for item in values:
        result.append(item)
    return result
`,
  'read.go': `package demo
import "regexp"
func read(values []string) {
    cached := regexp.MustCompile("ab")
    for _, value := range values {
        _ = regexp.MustCompile("ab").MatchString(value)
        _ = cached.MatchString(value)
        _, _ = regexp.Compile(value)
        _ = func() { _ = regexp.MustCompile("deferred") }
    }
}
`,
  'Read.java': `import java.util.regex.Pattern;
class Read {
    void load(String[] values) {
        Pattern cached = Pattern.compile("ab");
        for (String value : values) {
            Pattern.compile("ab").matcher(value);
            cached.matcher(value);
            Pattern.compile(value);
            Runnable deferred = () -> Pattern.compile("deferred");
        }
    }
}
`,
  'Read.cs': `using System.Text.RegularExpressions;
class Read {
    void Run(string[] values) {
        var cached = new Regex("ab");
        foreach (var value in values) {
            new Regex(@"ab").IsMatch(value);
            cached.IsMatch(value);
            new Regex(value);
            System.Func<Regex> deferred = () => new Regex("deferred");
        }
    }
}
`,
  'read.rs': `use regex::Regex;
fn read(values: &[String]) {
    let cached = Regex::new("ab").unwrap();
    for value in values {
        let _ = Regex::new(r"ab").unwrap().is_match(value);
        let _ = cached.is_match(value);
        let _ = Regex::new(value);
        let _ = || Regex::new("deferred");
    }
}
`,
  'sgconfig.yml': 'this is deliberately invalid YAML: [',
};

test(
  'polyglot uses its bundled rules and reports only the five direct repeated operations',
  nativeOnly,
  async (context) => {
    const directory = fixture(context, samples);
    const result = await checkPolyglot([directory]);
    assert.equal(result.scannedFiles, 5);
    assert.deepEqual(
      result.findings
        .map((finding): [string, number | undefined, string] => [
          path.basename(fileOf(finding)),
          finding.line,
          finding.ruleId,
        ])
        .sort((left, right) => left[2].localeCompare(right[2])),
      [
        ['Read.cs', 6, 'csharp-fixed-regex-in-loop'],
        ['read.go', 6, 'go-fixed-regexp-in-loop'],
        ['Read.java', 6, 'java-fixed-regex-in-loop'],
        ['items.py', 4, 'python-copy-growing-list'],
        ['read.rs', 5, 'rust-fixed-regex-in-loop'],
      ],
    );
    assert.ok(result.findings.every((finding) => finding.column > 0 && finding.message));
    const overlap = await checkPolyglot([path.join(directory, 'items.py'), directory]);
    assert.deepEqual(overlap, result);
  },
);

test('polyglot accepts clean explicit input and reports missing or unsupported inputs', async (context) => {
  const directory = fixture(context, { 'clean.py': 'print("ok")', 'notes.txt': 'example' });
  if (nativeAvailable) assert.deepEqual((await checkPolyglot([path.join(directory, 'clean.py')])).findings, []);
  else await assert.rejects(checkPolyglot([path.join(directory, 'clean.py')]), /optional @ast-grep/);
  await assert.rejects(checkPolyglot([]), /Pass at least one/);
  await assert.rejects(checkPolyglot([path.join(directory, 'missing.rs')]), /does not exist/);
  await assert.rejects(checkPolyglot([path.join(directory, 'notes.txt')]), /Expected a directory/);
});

test(
  'directory scans skip dependency and build trees while explicit files remain scannable',
  nativeOnly,
  async (context) => {
    const source = samples['items.py'];
    const directory = fixture(context, {
      'application.py': source,
      'generated.py': source,
      '.gitignore': 'generated.py\n',
    });
    const excluded = ['node_modules', 'vendor', 'dist'].map((name) => path.join(directory, name));
    const gitDirectory = path.join(directory, '.git');
    for (const folder of excluded) {
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'example.py'), source);
    }
    try {
      const applicationFiles = (result: Awaited<ReturnType<typeof checkPolyglot>>) =>
        result.findings.map((finding) => path.basename(fileOf(finding))).sort();
      assert.deepEqual(applicationFiles(await checkPolyglot([directory])), ['application.py', 'generated.py']);
      fs.mkdirSync(gitDirectory);
      assert.deepEqual(applicationFiles(await checkPolyglot([directory])), ['application.py']);
      const requested = path.join(excluded[0], 'example.py');
      assert.deepEqual(applicationFiles(await checkPolyglot([directory, requested])), ['application.py', 'example.py']);
    } finally {
      if (fs.existsSync(gitDirectory)) fs.rmdirSync(gitDirectory);
      for (const folder of excluded) {
        fs.unlinkSync(path.join(folder, 'example.py'));
        fs.rmdirSync(folder);
      }
    }
  },
);

test(
  'polyglot excludes common shadowed or unrelated regex APIs and loop control expressions',
  nativeOnly,
  async (context) => {
    const directory = fixture(context, {
      'shadow.go': `package demo
import "regexp"
var _ = regexp.MustCompile("outside")
type custom struct{}
func (custom) MustCompile(string) {}
func use(regexp custom, input []string) { for range input { regexp.MustCompile("shadow") } }`,
      'Shadow.java': `import java.util.regex.Pattern;
class Shadow {
  static class Fake { void compile(String p) {} }
  void load(Fake Pattern) { while (true) { Pattern.compile("shadow"); } }
}`,
      'Shadow.cs': `using System.Text.RegularExpressions;
using Regex = Custom.Widget;
class Shadow { void Load() { while (true) { new Regex("shadow"); } } }`,
      'shadow.rs': `use other::Regex;
fn load(values: &[u32]) { for _ in values { let _ = Regex::new("unrelated"); } }`,
      'control.py': `def check(values):
    items = []
    for items in values:
        items = items + [3]
    return items`,
    });
    assert.deepEqual((await checkPolyglot([directory])).findings, []);
  },
);

test(
  'polyglot omits zero or one Python iterations and locally shadowed Java and Rust regex constructors',
  nativeOnly,
  async (context) => {
    const directory = fixture(context, {
      'items.py': `def scan(values):
    empty = []
    for item in []:
        empty = empty + [item]
    single = []
    for item in (42,):
        single = single + [item]
    spread = []
    for item in [*values]:
        spread = spread + [item]`,
      'Shadow.java': `import java.util.regex.Pattern;
class Shadow {
  static class Fake { void compile(String p) {} }
  void load(Fake[] values) { for (Fake Pattern : values) { Pattern.compile("shadow"); } }
}`,
      'shadow.rs': `mod regex {
    pub struct Regex;
    impl Regex { pub fn new(_: &str) -> Self { Self } }
}
fn load(values: &[i32]) { for _ in values { let _ = regex::Regex::new("local"); } }`,
      'alias.rs': `use crate::custom as regex;
mod custom { pub struct Regex; impl Regex { pub fn new(_: &str) -> Self { Self } } }
fn load(values: &[i32]) { for _ in values { let _ = regex::Regex::new("local"); } }`,
    });
    const { findings } = await checkPolyglot([directory]);
    assert.deepEqual(
      findings.map(({ ruleId, line }) => [ruleId, line]),
      [['python-copy-growing-list', 10]],
    );
  },
);

test('polyglot counts an empty supported file once and surfaces native input failures', nativeOnly, async (context) => {
  const directory = fixture(context, { 'empty.rs': '', 'bad.py': Buffer.from([255, 254, 255]) });
  assert.deepEqual(await checkPolyglot([path.join(directory, 'empty.rs')]), {
    scannedFiles: 1,
    skippedFiles: 0,
    findings: [],
  });
  await assert.rejects(checkPolyglot([directory]), /invalidUtf8/);
});

test('explicit and directory inputs scan all supported mixed-case extensions', nativeOnly, async (context) => {
  const languageFiles = Object.entries(samples).filter(([name]) => name !== 'sgconfig.yml');
  const names = ['items.PY', 'read.gO', 'Read.JaVa', 'Read.CS', 'read.Rs'];
  const directory = fixture(
    context,
    Object.fromEntries(languageFiles.map(([, source], index) => [names[index], source])),
  );
  const explicit = names.map((filename) => path.join(directory, filename));
  const result = await checkPolyglot(explicit);
  assert.equal(result.scannedFiles, names.length);
  assert.deepEqual(result.findings.map(({ file }) => path.basename(file)).sort(), [...names].sort());
  assert.deepEqual(await checkPolyglot([directory, ...explicit]), result);
  const sameFile = path.join(directory, 'ITEMS.py');
  if (fs.existsSync(sameFile)) assert.deepEqual(await checkPolyglot([...explicit, sameFile]), result);
});

test('polyglot reports parser error nodes as invalid inputs', nativeOnly, async (context) => {
  const directory = fixture(context, {
    'bad.py': 'def = not valid(',
    'bad.go': 'package demo\nfunc ??? {',
    'Bad.java': 'class Broken { void ??? }',
    'Bad.cs': 'class Broken { void ??? }',
    'bad.rs': 'fn ??? {',
  });
  for (const filename of fs.readdirSync(directory)) {
    await assert.rejects(checkPolyglot([path.join(directory, filename)]), /invalid or unsupported syntax/);
  }
});

test(
  'polyglot keeps findings and source positions around Java varargs annotations and C# conditional writes',
  nativeOnly,
  async (context) => {
    const directory = fixture(context, {
      'Read.java': samples['Read.java']
        .replace(
          'class Read',
          '@java.lang.annotation.Target(java.lang.annotation.ElementType.TYPE_USE) @interface Nullable {} class Read',
        )
        .replace('String[] values', 'String @Nullable ... values'),
      'Read.cs': samples['Read.cs'].replace('cached.IsMatch(value);', 'this?.Sink = value; cached.IsMatch(value);'),
    });
    const report = await checkPolyglot([directory]);
    assert.equal(report.scannedFiles, 2);
    assert.deepEqual(
      report.findings.map(({ ruleId, line, column }) => [ruleId, line, column]),
      [
        ['csharp-fixed-regex-in-loop', 6, 13],
        ['java-fixed-regex-in-loop', 6, 13],
      ],
    );
    const java = path.join(directory, 'Read.java');
    const original = fs.readFileSync(java, 'utf8');
    assert.match(original, /String @Nullable \.\.\. values/);
    for (const malformed of ['org..Nullable', 'class']) {
      fs.writeFileSync(java, original.replace('@Nullable', '@' + malformed));
      await assert.rejects(checkPolyglot([java]), /Read\.java:.*invalid or unsupported syntax/);
    }
    fs.writeFileSync(java, original.replace('cached.matcher(value);', 'void ???;'));
    await assert.rejects(checkPolyglot([java]), /Read\.java:.*invalid or unsupported syntax/);
    const csharp = path.join(directory, 'Read.cs');
    const conditional = fs.readFileSync(csharp, 'utf8');
    assert.match(conditional, /this\?\.Sink = value/);
    for (const missingValue of ['', '/* missing */']) {
      fs.writeFileSync(csharp, `class Probe { void Run() { target?.Value = ${missingValue}; } }`);
      await assert.rejects(checkPolyglot([csharp]), /Read\.cs:.*invalid or unsupported syntax/);
    }
    fs.writeFileSync(csharp, conditional.replace('cached.IsMatch(value);', 'void ???;'));
    await assert.rejects(checkPolyglot([csharp]), /Read\.cs:.*invalid or unsupported syntax/);
  },
);
