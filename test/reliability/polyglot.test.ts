import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { checkPolyglot } from '../../lib/performance/polyglot.js';
import { polyglotRules } from '../../lib/reliability/rule-ids.js';
import type { FileMap } from '../types/project-files.js';
import { resolveBinaryPath } from '@ast-grep/cli/postinstall.js';

let nativeAvailable = false;
try {
  nativeAvailable = Boolean(resolveBinaryPath());
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND')) throw error;
}
const nativeOnly = { skip: nativeAvailable ? false : 'optional ast-grep native binary is absent' };

function fixture(context: TestContext, files: FileMap): string {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'loadwise rel polyglot '));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function reliabilityIds(directory: string): Promise<string[]> {
  const scan = await checkPolyglot([directory], 'reliability');
  return scan.findings.map((finding) => `${path.basename(finding.file)}:${finding.line}:${finding.ruleId}`);
}

const rulesDirectory = path.resolve(import.meta.dirname, '../../polyglot/reliability/rules');

test('every reliability polyglot rule id is registered and every registered id has a rule', () => {
  const declared = fs
    .readdirSync(rulesDirectory)
    .filter((name) => name.endsWith('.yml'))
    .flatMap((name) => [...fs.readFileSync(path.join(rulesDirectory, name), 'utf8').matchAll(/^id: (\S+)$/gm)])
    .map((match) => match[1]);
  assert.deepEqual([...declared].sort(), [...polyglotRules].sort());
});

test('Python rules flag bare and swallowed exceptions and keep expected control flow', nativeOnly, async (context) => {
  const directory = fixture(context, {
    'service.py': `def run(items):
    try:
        work()
    except:
        pass
    try:
        work()
    except Exception:
        pass
    try:
        work()
    except (OSError, Exception):
        ...
    try:
        import ujson
    except ImportError:
        pass
    try:
        work()
    except ValueError as error:
        log(error)
    try:
        work()
    except StopIteration:
        pass
`,
    'test_service.py': `def test_it():
    try:
        work()
    except:
        pass
`,
    'tests/helper.py': `def helper():
    try:
        work()
    except ValueError:
        pass
`,
  });
  assert.deepEqual(await reliabilityIds(directory), [
    'service.py:4:python-bare-except',
    'service.py:8:python-swallowed-exception',
    'service.py:12:python-swallowed-exception',
  ]);
  assert.deepEqual((await checkPolyglot([directory])).findings, []);
});

test('Go rules flag discarded errors and early defers, not tests or defers', nativeOnly, async (context) => {
  const directory = fixture(context, {
    'main.go': `package demo

import (
	"os"
	"strconv"
)

func run(file *os.File, values map[string]int, name string) {
	number, _ := strconv.Atoi(name)
	_ = file.Close()
	_ = file.Sync()
	count, _ := values[name]
	value, _ := os.LookupEnv("HOME")
	_ = number + count
	_ = value
	defer file.Close()
}

func open(path string) error {
	handle, err := os.Open(path)
	defer handle.Close()
	if err != nil {
		return err
	}
	other, err := os.Open(path)
	if err != nil {
		return err
	}
	defer other.Close()
	return nil
}

func fetch(u string, db *sql.DB) error {
	resp, err := http.Get(u)
	defer resp.Body.Close()
	if err != nil {
		return err
	}
	rows, err := db.Query("x")
	defer rows.Close()
	return err
}
`,
    'main_test.go': `package demo

import "os"

func helper(file *os.File) {
	_ = file.Close()
	handle, err := os.Open("x")
	defer handle.Close()
	_ = err
}
`,
  });
  assert.deepEqual(await reliabilityIds(directory), [
    'main.go:9:go-error-discarded',
    'main.go:11:go-error-discarded',
    'main.go:35:go-defer-before-error-check',
    'main.go:40:go-defer-before-error-check',
  ]);
  assert.deepEqual((await checkPolyglot([directory])).findings, []);
});

test('Java rule flags resources outside try-with-resources only', nativeOnly, async (context) => {
  const directory = fixture(context, {
    'Reader.java': `import java.io.*;
import java.sql.*;

class Reader {
  void leaks(String path, javax.sql.DataSource dataSource) throws Exception {
    BufferedReader reader = new BufferedReader(new FileReader(path));
    Connection connection = DriverManager.getConnection("jdbc:x");
    Connection pooled = dataSource.getConnection();
    try (BufferedReader safe = new BufferedReader(new FileReader(path))) {
      safe.readLine();
    }
    FileInputStream manual = new FileInputStream(path);
    try {
      manual.read();
    } finally {
      manual.close();
    }
    StringBuilder builder = new StringBuilder();
  }
}
`,
    'src/test/java/ReaderTest.java': `import java.io.*;

class ReaderTest {
  void check() throws Exception {
    FileReader reader = new FileReader("x");
  }
}
`,
  });
  assert.deepEqual(await reliabilityIds(directory), [
    'Reader.java:6:java-resource-without-try',
    'Reader.java:7:java-resource-without-try',
    'Reader.java:8:java-resource-without-try',
  ]);
  assert.deepEqual((await checkPolyglot([directory])).findings, []);
});

test('C# rule flags undisposed streams and connections but not using or HttpClient', nativeOnly, async (context) => {
  const directory = fixture(context, {
    'Store.cs': `using System.IO;
using System.Net.Http;
using Microsoft.Data.SqlClient;

class Store {
  void Run(string path) {
    var stream = new FileStream(path, FileMode.Open);
    var connection = new SqlConnection("x");
    using var safe = new StreamReader(path);
    using (var scoped = new StreamWriter(path)) { scoped.Write("x"); }
    var client = new HttpClient();
    var builder = new System.Text.StringBuilder();
  }
}
`,
    'StoreTests.cs': `using System.IO;

class StoreTests {
  void Check() {
    var stream = new FileStream("x", FileMode.Open);
  }
}
`,
  });
  assert.deepEqual(await reliabilityIds(directory), [
    'Store.cs:7:csharp-disposable-without-using',
    'Store.cs:8:csharp-disposable-without-using',
  ]);
  assert.deepEqual((await checkPolyglot([directory])).findings, []);
});

test('Rust rule flags unwrap in production code only', nativeOnly, async (context) => {
  const directory = fixture(context, {
    'lib.rs': `use std::sync::Mutex;

static NAME: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| "a".parse().unwrap());

pub fn parse(input: &str, lock: &Mutex<i32>) -> i32 {
    let guard = lock.lock().unwrap();
    let value = input.parse::<i32>().unwrap();
    let safe = input.parse::<i32>().unwrap_or(0);
    value + safe + *guard
}

#[test]
fn single_test() {
    "1".parse::<i32>().unwrap();
}

#[cfg(test)]
mod tests {
    #[test]
    fn nested() {
        "1".parse::<i32>().unwrap();
    }
}
`,
    'tests/integration.rs': `fn check() {
    "1".parse::<i32>().unwrap();
}
`,
    'build.rs': `fn main() {
    "1".parse::<i32>().unwrap();
}
`,
  });
  assert.deepEqual(await reliabilityIds(directory), ['lib.rs:7:rust-unwrap-in-production']);
  assert.deepEqual((await checkPolyglot([directory])).findings, []);
});

test('regression: C# async void with modifiers, handler shapes and ownership transfer', nativeOnly, async (context) => {
  const directory = fixture(context, {
    'Handlers.cs': `class Handlers {
  public async void Foo() {}
  protected override async void Bar() {}
  async void Ok(object sender, EventArgs e) {}
  async void Click(Button sender, RoutedEventArgs e) {}
  async void Two(int a, int b) {}
  async Task Fine() {}
  void Owned() {
    var stream = new FileStream("a", FileMode.Open);
    using var reader = new StreamReader(stream);
    var guarded = new FileStream("b", FileMode.Open);
    try { guarded.Read(); } finally { guarded.Dispose(); }
    var returned = new FileStream("c", FileMode.Open);
    var scoped = new FileStream("d", FileMode.Open);
    using (scoped) { scoped.Read(); }
    return returned;
  }
  void Leaks() {
    var leak = new FileStream("x", FileMode.Open);
    leak.Read();
  }
}
`,
  });
  assert.deepEqual(await reliabilityIds(directory), [
    'Handlers.cs:2:csharp-async-void',
    'Handlers.cs:6:csharp-async-void',
    'Handlers.cs:19:csharp-disposable-without-using',
  ]);
});

test('regression: Go non-error results and deliberate Close discard', nativeOnly, async (context) => {
  const directory = fixture(context, {
    'main.go': `package demo

func run() {
	dir, _ := filepath.Split(path)
	char, _ := utf8.DecodeRuneInString(text)
	caller, _, _, _ := runtime.Caller(0)
	index, _ := slices.BinarySearch(items, 1)
	user, _ := request.BasicAuth()
	_ = file.Close()
	_ = file.Sync()
	value, _ := cache.Get("k")
	item, _ := queue.Pop()
	body, _ := json.Marshal(item)
	found, _ := lru.Get(1)
}
`,
  });
  assert.deepEqual(await reliabilityIds(directory), ['main.go:10:go-error-discarded', 'main.go:13:go-error-discarded']);
});

test('regression: Java later try/finally, return and field assignment', nativeOnly, async (context) => {
  const directory = fixture(context, {
    'Owned.java': `import java.io.*;

class Owned {
  FileReader field;
  FileReader returned(String path) throws Exception {
    FileReader guarded = new FileReader(path);
    work();
    try { guarded.read(); } finally { guarded.close(); }
    FileReader result = new FileReader(path);
    return result;
  }
  void java9(javax.sql.DataSource ds) throws Exception {
    java.sql.Connection conn = DriverManager.getConnection("jdbc:x");
    try (conn) { conn.close(); }
  }
  void stored(String path) throws Exception {
    FileReader kept = new FileReader(path);
    this.field = kept;
    FileReader leaked = new FileReader(path);
    leaked.read();
  }
}
`,
  });
  assert.deepEqual(await reliabilityIds(directory), ['Owned.java:19:java-resource-without-try']);
});

test('regression: Python re-raising bare except and only broad swallowed catches', nativeOnly, async (context) => {
  const directory = fixture(context, {
    'service.py': `def run():
    try:
        work()
    except:
        cleanup()
        raise
    try:
        work()
    except FileNotFoundError:
        pass
    try:
        work()
    except (ValueError, ImportError):
        pass
    try:
        work()
    except Exception:
        pass
    try:
        work()
    except (ValueError, BaseException):
        pass
`,
  });
  assert.deepEqual(await reliabilityIds(directory), [
    'service.py:17:python-swallowed-exception',
    'service.py:21:python-swallowed-exception',
  ]);
});

test('regression: Rust test attributes and test-only files', nativeOnly, async (context) => {
  const directory = fixture(context, {
    'lib.rs': `fn prod() { "1".parse::<i32>().unwrap(); }
#[tokio::test(flavor = "multi_thread")]
async fn first() { "1".parse::<i32>().unwrap(); }
#[test_case(1)]
fn second(value: i32) { "1".parse::<i32>().unwrap(); }
#[rstest(value, case(1))]
fn third(value: i32) { "1".parse::<i32>().unwrap(); }
#[cfg(all(test, feature = "x"))]
mod checks { fn nested() { "1".parse::<i32>().unwrap(); } }
#[wasm_bindgen_test]
fn wasm() { "1".parse::<i32>().unwrap(); }
#[bench]
fn timing() { "1".parse::<i32>().unwrap(); }
#[quickcheck]
fn prop() { "1".parse::<i32>().unwrap(); }
#[cfg(test)]
impl Helper { fn build() { "1".parse::<i32>().unwrap(); } }
`,
    'tests.rs': `fn check() { "1".parse::<i32>().unwrap(); }
`,
    'parser_test.rs': `fn check() { "1".parse::<i32>().unwrap(); }
`,
    'inner.rs': `#![cfg(test)]
fn check() { "1".parse::<i32>().unwrap(); }
`,
  });
  assert.deepEqual(await reliabilityIds(directory), ['lib.rs:1:rust-unwrap-in-production']);
});
