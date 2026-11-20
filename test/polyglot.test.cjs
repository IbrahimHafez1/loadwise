'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { checkPolyglot } = require('../lib/polyglot.cjs');
let nativeAvailable = false;
try {
  nativeAvailable = Boolean(require('@ast-grep/cli/postinstall.js').resolveBinaryPath());
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
const nativeOnly = { skip: nativeAvailable ? false : 'optional ast-grep native binary is absent' };

function fixture(context, files) {
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
        .map((finding) => [path.basename(finding.file), finding.line, finding.ruleId])
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
