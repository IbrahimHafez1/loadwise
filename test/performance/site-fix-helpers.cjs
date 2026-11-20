'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeSources } = require('../../lib/performance/projects.cjs');
const { attachSiteFixes } = require('../../lib/performance/site-fix.cjs');

// Writes `files` (relative name -> contents, node_modules stubs included) to a temporary project, scans every
// non-declaration source in it, and returns the findings with their site fixes attached.
function scanWithFixes(context, files, { tsconfig } = {}) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backend-perf-fix-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  let result;
  if (tsconfig) {
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
    result = analyzeSources({ project: path.join(root, 'tsconfig.json') });
  } else {
    const sources = Object.keys(files)
      .filter((name) => !name.startsWith('node_modules/') && /\.[cm]?[jt]sx?$/.test(name) && !name.endsWith('.d.ts'))
      .map((name) => path.join(root, name));
    result = analyzeSources({ files: sources });
  }
  attachSiteFixes(result.findings);
  return { root, findings: result.findings };
}

// The single change of a fix, with common indentation removed from both sides for readable assertions.
function onlyChange(finding) {
  if (!finding?.fix) return;
  if (finding.fix.changes.length !== 1) throw new Error('expected one change, got ' + finding.fix.changes.length);
  const { before, after } = finding.fix.changes[0];
  return { before: dedent(before), after: dedent(after) };
}

function dedent(text) {
  const lines = text.split('\n');
  const indentation = Math.min(...lines.filter((line) => line.trim()).map((line) => /^\s*/.exec(line)[0].length));
  return lines.map((line) => line.slice(indentation)).join('\n');
}

module.exports = { scanWithFixes, onlyChange, dedent };
