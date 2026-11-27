import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { checkPolyglot } from '../../lib/performance/polyglot.js';
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
  const directory = fs.mkdtempSync(path.join(base, 'loadwise perf polyglot v2 '));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content);
  context.after(() => {
    for (const name of Object.keys(files)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  return directory;
}

const perfRulesDir = path.resolve(import.meta.dirname, '../../polyglot/performance/rules');
const expectedNewRules: Record<string, readonly string[]> = {
  'python.yml': ['python-n-plus-one-orm-loop', 'python-unbounded-comprehension'],
  'go.yml': ['go-sql-query-in-loop', 'go-string-concat-in-loop'],
  'java.yml': ['java-string-concat-in-loop', 'java-jdbc-query-in-loop'],
  'csharp.yml': ['csharp-string-concat-in-loop'],
  'rust.yml': ['rust-clone-in-loop', 'rust-format-in-loop'],
};

test('csharp-async-void lives in the reliability polyglot rules only', () => {
  const reliabilityRules = path.resolve(import.meta.dirname, '../../polyglot/reliability/rules/csharp.yml');
  assert.ok(fs.readFileSync(reliabilityRules, 'utf8').includes('id: csharp-async-void'));
  assert.ok(!fs.readFileSync(path.join(perfRulesDir, 'csharp.yml'), 'utf8').includes('id: csharp-async-void'));
});

test('performance polyglot rule YAML files contain all Phase 5 rule IDs', () => {
  for (const [file, ruleIds] of Object.entries(expectedNewRules)) {
    const content = fs.readFileSync(path.join(perfRulesDir, file), 'utf8');
    for (const id of ruleIds) {
      assert.ok(content.includes(`id: ${id}`), `Expected ${id} in ${file}`);
    }
  }
});

test(
  'Phase 5 Python, Go, Java, C# and Rust performance rules detect anti-patterns and ignore safe code',
  nativeOnly,
  async (context) => {
    const directory = fixture(context, {
      'queries.py': `def load_users(ids, session, counts):
    for uid in ids:
        session.query(uid)
    total = sum([x * 2 for x in counts])
    gen_total = sum(x * 2 for x in counts)
    return total + gen_total
`,
      'loop.go': `package demo
import "database/sql"
func load(db *sql.DB, ids []string) string {
    out := ""
    sum := 0
    for i, id := range ids {
        db.Query("SELECT * FROM users WHERE id = $1", id)
        out += id
        sum += i
    }
    return out
}
`,
      'Loop.java': `import java.sql.Statement;
class Loop {
    String build(Statement stmt, String[] items) throws Exception {
        String acc = "";
        int count = 0;
        for (String item : items) {
            acc += item;
            count += 1;
            stmt.executeQuery("SELECT 1");
        }
        return acc + count;
    }
}
`,
      'AsyncSample.cs': `using System;
using System.Threading.Tasks;
class AsyncSample {
    async void BadWork() {
        await Task.Delay(1);
    }
    async void OnClick(object sender, EventArgs e) {
        await Task.Delay(1);
    }
    string Join(string[] items) {
        string acc = "";
        foreach (var item in items) {
            acc += item;
        }
        return acc;
    }
}
`,
      'items.rs': `fn collect(items: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for item in items {
        let s = format!("{}", item);
        out.push(s.clone());
    }
    out
}
`,
    });

    const result = await checkPolyglot([directory]);
    assert.equal(result.scannedFiles, 5);
    const foundIds = result.findings.map((finding) => finding.ruleId).sort();
    assert.deepEqual(foundIds, [
      'csharp-string-concat-in-loop',
      'go-sql-query-in-loop',
      'go-string-concat-in-loop',
      'java-jdbc-query-in-loop',
      'java-string-concat-in-loop',
      'python-n-plus-one-orm-loop',
      'python-unbounded-comprehension',
      'rust-clone-in-loop',
      'rust-format-in-loop',
    ]);
    const reliability = await checkPolyglot([directory], 'reliability');
    assert.deepEqual(
      reliability.findings.map((finding) => finding.ruleId),
      ['csharp-async-void'],
    );
  },
);
