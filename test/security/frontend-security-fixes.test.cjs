'use strict';

// The builders take bundled-TypeScript nodes, as lib/performance/site-fix.cjs hands them to a rule's builder.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const frontendFixes = require('../../lib/security/site-fixes/frontend-security-fixes.cjs');
const backendFixes = require('../../lib/security/site-fixes/backend-security-fixes.cjs');

// The innermost node starting at `offset`, which is the node a builder receives for a finding there.
function nodeAt(sourceFile, offset) {
  let found;
  (function visit(node) {
    if (node.getStart(sourceFile) <= offset && offset < node.end) {
      if (node.getStart(sourceFile) === offset) found = node;
      ts.forEachChild(node, visit);
    }
  })(sourceFile);
  return found;
}

function applyFix(ruleId, source, marker, builders = frontendFixes) {
  const sourceFile = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const fix = builders[ruleId]({ node: nodeAt(sourceFile, source.indexOf(marker)), sourceFile, text: source });
  if (!fix) return;
  const edits = [...fix.edits].sort((left, right) => right.start - left.start);
  const fixed = edits.reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
  return { fix, fixed };
}

function assertParses(source) {
  const sourceFile = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  assert.deepEqual(sourceFile.parseDiagnostics, [], source);
}

test('dom-xss-sink: innerHTML assignment becomes textContent, behind review', () => {
  const result = applyFix(
    'dom-xss-sink',
    'declare const el: HTMLElement;\nel.innerHTML = location.hash;',
    'el.innerHTML',
  );
  assert.equal(result.fixed, 'declare const el: HTMLElement;\nel.textContent = location.hash;');
  assert.equal(result.fix.requiresReview, true);
  assert.match(result.fix.note, /DOMPurify/);
});

test('dom-xss-sink: call sinks and compound assignments get no fix', () => {
  const sources = [
    ['declare const el: HTMLElement;\nel.insertAdjacentHTML("beforeend", location.hash);', 'el.insert'],
    ['declare const el: HTMLElement;\nel.innerHTML += location.hash;', 'el.innerHTML'],
    ['declare const el: HTMLElement;\nel.outerHTML = location.hash;', 'el.outerHTML'],
  ];
  for (const [source, marker] of sources) assert.equal(applyFix('dom-xss-sink', source, marker), undefined, source);
});

test('postmessage: a wildcard posted to the own window becomes its origin, behind review', () => {
  for (const receiver of ['window', 'self', 'globalThis']) {
    const result = applyFix('postmessage-missing-origin-check', `${receiver}.postMessage('x', '*');`, receiver);
    assert.equal(result.fixed, `${receiver}.postMessage('x', ${receiver}.location.origin);`);
    assert.equal(result.fix.requiresReview, true);
    assert.match(result.fix.note, /file:/);
  }
});

test('postmessage: another window or an options object gets no fix', () => {
  const sources = [
    ["window.parent.postMessage('x', '*');", 'window.parent'],
    ["declare const frame: HTMLIFrameElement;\nframe.contentWindow!.postMessage('x', '*');", 'frame'],
    ["window.postMessage('x', { targetOrigin: '*' });", 'window'],
  ];
  for (const [source, marker] of sources)
    assert.equal(applyFix('postmessage-missing-origin-check', source, marker), undefined, source);
});

test('express-missing-helmet: ES module files get an import and the middleware right after the app', () => {
  const source =
    "import express from 'express';\nimport cors from 'cors';\n\nconst app = express();\napp.get('/', () => 1);\napp.listen(3000);\n";
  const result = applyFix('express-missing-helmet', source, 'app.listen', backendFixes);
  assert.equal(
    result.fixed,
    "import express from 'express';\nimport cors from 'cors';\nimport helmet from 'helmet';\n\nconst app = express();\napp.use(helmet());\napp.get('/', () => 1);\napp.listen(3000);\n",
  );
  assert.equal(result.fix.requiresReview, true);
  assertParses(result.fixed);
});

test('express-missing-helmet: CommonJS files get a require, NestJS apps get the same middleware', () => {
  const commonJs = "'use strict';\nconst express = require('express');\n\nconst app = express();\napp.listen(3000);\n";
  const common = applyFix('express-missing-helmet', commonJs, 'app.listen', backendFixes);
  assert.equal(
    common.fixed,
    "'use strict';\nconst express = require('express');\nconst helmet = require('helmet');\n\nconst app = express();\napp.use(helmet());\napp.listen(3000);\n",
  );
  const nest =
    "import { NestFactory } from '@nestjs/core';\nasync function main() {\n  const app = await NestFactory.create({});\n  await app.listen(3000);\n}\n";
  const nested = applyFix('express-missing-helmet', nest, 'app.listen', backendFixes);
  assert.match(nested.fixed, /\{\}\);\n {2}app\.use\(helmet\(\)\);\n {2}await app\.listen/);
  assert.match(nested.fixed, /^import \{ NestFactory \} from '@nestjs\/core';\nimport helmet from 'helmet';/);
  assertParses(nested.fixed);
});

test('express-missing-helmet: no fix when the app, the module style or the name is unclear', () => {
  const cases = [
    "import express from 'express';\nimport { app } from './app';\napp.listen(3000);\n",
    "import express from 'express';\nconst helmet = 1;\nconst app = express();\napp.listen(3000);\n",
    'const app = express();\napp.listen(3000);\n',
  ];
  for (const source of cases)
    assert.equal(applyFix('express-missing-helmet', source, 'app.listen', backendFixes), undefined, source);
});
