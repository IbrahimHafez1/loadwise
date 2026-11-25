import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import type { Finding } from '../../lib/shared/types.js';

interface PillarSection {
  findings?: Finding[];
}

const repoRoot = path.resolve(import.meta.dirname, '../..');
const cli = path.join(repoRoot, 'bin/loadwise.js');
const configFile = 'scripts/self-scan/loadwise.config.json';
const baselineFile = 'scripts/self-scan/loadwise-baseline.json';
const SCAN_TIMEOUT_MS = 180_000;

function newFindings(report: Record<string, PillarSection>): string[] {
  return Object.entries(report).flatMap(([pillar, section]) =>
    (section.findings || []).map(
      ({ ruleId, file, line, message }) =>
        `${pillar} ${ruleId} ${String(file).replaceAll('\\', '/')}:${line} ${message}`,
    ),
  );
}

// Loadwise checks its own lib/, bin/ and scripts/ against the baseline in scripts/self-scan/ (scope
// in its config). After an intended fix or a deliberate new finding, refresh it with:
//   npm run selfscan:baseline
test(
  'loadwise reports no findings in its own source beyond the committed baseline',
  { timeout: SCAN_TIMEOUT_MS },
  () => {
    const run = spawnSync(
      process.execPath,
      [cli, 'check', '.', '--config', configFile, '--baseline', baselineFile, '--fail-on', 'all', '--json'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        timeout: SCAN_TIMEOUT_MS,
        env: { ...process.env, LOADWISE_NO_CACHE: '1' },
      },
    );
    assert.notEqual(run.status, 2, `scan failed to run:\n${run.stderr}`);
    let report: Record<string, PillarSection>;
    try {
      report = JSON.parse(run.stdout);
    } catch {
      assert.fail(`scan output was not JSON (exit ${run.status}):\n${run.stdout}\n${run.stderr}`);
    }
    assert.equal(
      run.status,
      0,
      `New findings not in the self-scan baseline:\n${newFindings(report).join('\n')}\nFix them, or regenerate the baseline.`,
    );
  },
);
