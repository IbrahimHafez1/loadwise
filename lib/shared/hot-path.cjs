'use strict';

// How hot the code behind a finding is: code that serves a request matters more than a scheduled job, which matters
// more than a script, seed or migration, and tests matter least. The rank only orders and labels findings; it never
// feeds the finding id, so baselines and SARIF fingerprints are unaffected.
const hotPathRanks = ['request', 'background', 'unknown', 'script', 'test'];
const rankLabels = {
  request: 'request path',
  background: 'background job',
  script: 'script or migration',
  test: 'test',
};
const unknownOrder = hotPathRanks.indexOf('unknown');

function hotPathOrder(finding) {
  const index = hotPathRanks.indexOf(finding.hotPath?.rank);
  return index === -1 ? unknownOrder : index;
}

// Undefined for unknown, so text output only names ranks that tell the reader something.
function hotPathLabel(finding) {
  return rankLabels[finding.hotPath?.rank];
}

// The graph module binds the compiler syntax, so it loads on the first finding rather than with the CLI.
function hotPathOf(node, program) {
  return require('./hot-path-graph.cjs').hotPathOf(node, program);
}

module.exports = { hotPathRanks, hotPathOf, hotPathOrder, hotPathLabel };
