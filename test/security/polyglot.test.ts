import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { checkSecurityPolyglot } from '../../lib/security/polyglot.js';
import { main as securityMain, usage as securityUsage } from '../../lib/security/cli.js';
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
  const directory = fs.mkdtempSync(path.join(base, 'loadwise sec polyglot '));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content);
  context.after(() => {
    for (const name of Object.keys(files)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  return directory;
}

const securityRuleRoot = path.resolve(import.meta.dirname, '../../polyglot/security');
const expectedRulesByLanguage: Record<string, readonly string[]> = {
  'python.yml': ['python-insecure-deserialization', 'python-unsafe-yaml-load', 'python-subprocess-shell-true'],
  'go.yml': ['go-exec-command-shell', 'go-sql-sprintf-injection'],
  'java.yml': ['java-runtime-exec', 'java-sql-string-concat'],
  'csharp.yml': ['csharp-process-start', 'csharp-ef-from-sql-raw'],
  'rust.yml': ['rust-command-shell', 'rust-unsafe-raw-pointer-deref'],
};

test('security polyglot sgconfig.yml and rule YAML files exist with expected rule IDs', () => {
  const sgconfig = fs.readFileSync(path.join(securityRuleRoot, 'sgconfig.yml'), 'utf8');
  assert.match(sgconfig, /ruleDirs:\s*\n\s*-\s*rules/);
  for (const [file, ruleIds] of Object.entries(expectedRulesByLanguage)) {
    const content = fs.readFileSync(path.join(securityRuleRoot, 'rules', file), 'utf8');
    for (const id of ruleIds) {
      assert.ok(content.includes(`id: ${id}`), `Expected ${id} in ${file}`);
    }
  }
});

test('loadwise sec polyglot validates arguments and prints usage on --help', async () => {
  assert.match(securityUsage, /loadwise sec polyglot/);
  const code = await securityMain(['polyglot', '--help']);
  assert.equal(code, 0);
  await assert.rejects(securityMain(['polyglot']), /Pass at least one/);
});

test('security polyglot scans Python, Go, Java, C# and Rust security patterns', nativeOnly, async (context) => {
  const directory = fixture(context, {
    'app.py': `import pickle, yaml, subprocess, os
data = pickle.loads(raw)
cfg = yaml.load(doc)
safe_cfg = yaml.load(doc, Loader=yaml.SafeLoader)
subprocess.run(cmd, shell=True)
subprocess.run(["ls", "-la"], shell=False)
`,
    'cmd.go': `package demo
import (
  "database/sql"
  "fmt"
  "os/exec"
)
func run(db *sql.DB, user string) {
  exec.Command("sh", "-c", user)
  exec.Command("ls", "-la")
  db.Query(fmt.Sprintf("SELECT * FROM users WHERE name = '%s'", user))
  db.Query("SELECT * FROM users WHERE name = $1", user)
}
`,
    'Exec.java': `import java.sql.Statement;
class Exec {
  void run(Statement stmt, String user) throws Exception {
    Runtime.getRuntime().exec(user);
    stmt.executeQuery("SELECT * FROM users WHERE name = '" + user + "'");
    stmt.executeQuery("SELECT * FROM users");
  }
}
`,
    'Proc.cs': `using System.Diagnostics;
class Proc {
  void Run(string arg, dynamic ctx, string name) {
    Process.Start(arg);
    ctx.Users.FromSqlRaw($"SELECT * FROM Users WHERE Name = {name}");
    ctx.Users.FromSqlRaw("SELECT * FROM Users");
  }
}
`,
    'unsafe_ops.rs': `use std::process::Command;
fn run(ptr: *const i32) -> i32 {
  let _ = Command::new("sh");
  let _ = Command::new("ls");
  unsafe { *ptr }
}
`,
  });

  const result = await checkSecurityPolyglot([directory]);
  assert.equal(result.scannedFiles, 5);
  const foundIds = result.findings.map((finding) => finding.ruleId).sort();
  assert.deepEqual(foundIds, [
    'csharp-ef-from-sql-raw',
    'csharp-process-start',
    'go-exec-command-shell',
    'go-sql-sprintf-injection',
    'java-runtime-exec',
    'java-sql-string-concat',
    'python-insecure-deserialization',
    'python-subprocess-shell-true',
    'python-unsafe-yaml-load',
    'rust-command-shell',
    'rust-unsafe-raw-pointer-deref',
  ]);
});

test('loadwise sec polyglot CLI dispatches and outputs JSON findings', nativeOnly, (context) => {
  const directory = fixture(context, {
    'vuln.py': `import pickle
pickle.loads(payload)
`,
  });
  const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
  const child = spawnSync(process.execPath, [bin, 'sec', 'polyglot', directory, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(child.status, 1);
  const parsed = JSON.parse(child.stdout);
  assert.equal(parsed.scannedFiles, 1);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].ruleId, 'python-insecure-deserialization');
});
