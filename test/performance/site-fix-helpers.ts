import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeSources, performanceAnalyzers } from '../../lib/performance/projects.js';
import { attachSiteFixes, loadBuilders } from '../../lib/performance/site-fix.js';

await loadBuilders();
import type { TestContext } from 'node:test';
import type { Finding, FindingFix } from '../../lib/shared/types.js';
import type { SourceAnalyzer } from '../../lib/performance/types/source-analyzer.js';
import type { FileMap } from '../types/project-files.js';
import type { FixSides, ScanWithFixesOptions } from '../types/site-fixes.js';
import { analyzeFile as securityAnalyzeFile } from '../../lib/security/analyze.js';

// Performance and security rules over one Program, as the editor runs them; the security rules'
// fixes are built here.
const withSecurity: SourceAnalyzer[] = [
  ...performanceAnalyzers,
  {
    pillar: 'security',
    analyzeFile: securityAnalyzeFile,
  },
];

// Writes `files` (relative name -> contents, node_modules stubs included) to a temporary project,
// scans every non-declaration source in it, and returns the findings with their site fixes
// attached.
function scanWithFixes(
  context: TestContext,
  files: FileMap,
  { tsconfig, analyzers }: ScanWithFixesOptions = {},
): { root: string; findings: Finding[] } {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backend-perf-fix-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  let result: ReturnType<typeof analyzeSources>;
  if (tsconfig) {
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
    result = analyzeSources({ project: path.join(root, 'tsconfig.json'), files: [], analyzers });
  } else {
    const sources = Object.keys(files)
      .filter((name) => !name.startsWith('node_modules/') && /\.[cm]?[jt]sx?$/.test(name) && !name.endsWith('.d.ts'))
      .map((name) => path.join(root, name));
    result = analyzeSources({ files: sources, analyzers });
  }
  attachSiteFixes(result.findings, { comments: false });
  return { root, findings: result.findings };
}

// The single change of a fix, with common indentation removed from both sides for readable
// assertions.
function onlyChange(finding: Finding | undefined): FixSides | undefined {
  if (!finding?.fix) return;
  if (finding.fix.changes.length !== 1) throw new Error('expected one change, got ' + finding.fix.changes.length);
  const { before, after } = finding.fix.changes[0];
  return { before: dedent(before), after: dedent(after) };
}

// onlyChange for fixtures whose finding must carry a fix.
function requireOnlyChange(finding: Finding | undefined): FixSides {
  const change = onlyChange(finding);
  assert.ok(change, 'expected the finding to carry a fix');
  return change;
}

// The fix of a finding the fixture expects to be fixable.
function requireFix(finding: Finding | undefined): FindingFix {
  assert.ok(finding?.fix, 'expected the finding to carry a fix');
  return finding.fix;
}

function dedent(text: string): string {
  const lines = text.split('\n');
  const indentation = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => (/^\s*/.exec(line) ?? [''])[0].length),
  );
  return lines.map((line) => line.slice(indentation)).join('\n');
}

function assertReportedWithoutFix(findings: Finding[]) {
  assert.ok(findings.length > 0, 'rule should report');
  assert.deepEqual(
    findings.map((finding: Finding) => finding.fix),
    findings.map(() => undefined),
  );
}

export { assertReportedWithoutFix, scanWithFixes, onlyChange, requireOnlyChange, requireFix, dedent, withSecurity };
