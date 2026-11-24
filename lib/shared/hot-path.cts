import type { Node } from 'typescript';
import type { Finding, ProgramAdapter } from './types.cjs';
import type * as HotPathGraph from './hot-path-graph.cjs';
// @ts-check
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

// The graph module binds the compiler syntax, so it loads on the first finding rather than with the
// CLI.
function hotPathOf(node: Node, program: ProgramAdapter) {
  const hotPathGraph: typeof HotPathGraph = require('./hot-path-graph.cjs');
  return hotPathGraph.hotPathOf(node, program);
}

export { hotPathRanks, hotPathOf, hotPathOrder, hotPathLabel };
