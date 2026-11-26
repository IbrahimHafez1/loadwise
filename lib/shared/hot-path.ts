import type { Finding } from './types.js';
// How hot the code behind a finding is: code that serves a request matters more than a scheduled job, which matters
// more than a script, seed or migration, and tests matter least. The rank only orders and labels findings; it never
// feeds the finding id, so baselines and SARIF fingerprints are unaffected.
const hotPathRanks = ['request', 'background', 'unknown', 'script', 'test'];
const rankLabels: Readonly<Partial<Record<string, string>>> = {
  request: 'request path',
  background: 'background job',
  script: 'script or migration',
  test: 'test',
};
const unknownOrder = hotPathRanks.indexOf('unknown');

function hotPathOrder(finding: Finding) {
  const index = hotPathRanks.indexOf(finding.hotPath?.rank ?? '');
  return index === -1 ? unknownOrder : index;
}

// Undefined for unknown, so text output only names ranks that tell the reader something.
function hotPathLabel(finding: Finding): string | undefined {
  return finding.hotPath ? rankLabels[finding.hotPath.rank] : undefined;
}

export { hotPathOrder, hotPathLabel };
