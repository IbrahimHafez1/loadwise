'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { checkPolyglot } = require('../../lib/performance/polyglot.cjs');
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
  const directory = fs.mkdtempSync(path.join(base, 'perfcheck polyglot python '));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content);
  context.after(() => {
    for (const name of Object.keys(files)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  return directory;
}

async function findingsFor(context, files) {
  const { findings } = await checkPolyglot([fixture(context, files)]);
  return findings.map(({ ruleId, line }) => [ruleId, line]);
}

test(
  'python-sync-requests-in-async reports blocking requests calls directly inside async def',
  nativeOnly,
  async (context) => {
    const found = await findingsFor(context, {
      'client.py': `import requests

async def fetch(url):
    requests.get(url)
    def helper():
        requests.post(url)
    return helper

def sync_fetch(url):
    requests.get(url)
`,
    });
    assert.deepEqual(found, [['python-sync-requests-in-async', 4]]);
  },
);

test(
  'python-blocking-sleep-in-async reports time.sleep only directly inside async def',
  nativeOnly,
  async (context) => {
    const found = await findingsFor(context, {
      'slow.py': `import time

async def wait():
    time.sleep(1)
    def helper():
        time.sleep(1)
    return helper

def sync_wait():
    time.sleep(1)
`,
      'untracked.py': `async def wait(time):
    time.sleep(1)
`,
    });
    assert.deepEqual(found, [['python-blocking-sleep-in-async', 4]]);
  },
);

test(
  'python-fixed-regex-in-loop reports literal re.compile calls directly in loop bodies',
  nativeOnly,
  async (context) => {
    const found = await findingsFor(context, {
      'loop.py': `import re

def scan(values):
    cached = re.compile("ab")
    for value in values:
        re.compile("ab")
        re.compile(value)
        cached.match(value)
        deferred = lambda: re.compile("x")
        def nested():
            re.compile("y")
    while values:
        re.compile(r"cd")
    re.compile("outside")
`,
      'no_import.py': `def scan(values, re):
    for value in values:
        re.compile("ab")
`,
    });
    assert.deepEqual(found, [
      ['python-fixed-regex-in-loop', 6],
      ['python-fixed-regex-in-loop', 13],
    ]);
  },
);
