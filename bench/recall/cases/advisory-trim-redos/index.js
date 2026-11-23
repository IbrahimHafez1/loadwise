// Pre-fix trim@0.0.1 (CVE-2020-7753, GHSA-w5p7-h5w8-2hfq): whitespace trimming regex is quadratic on long whitespace runs.
exports = module.exports = trim;

function trim(str) {
  return str.replace(/^\s*|\s*$/g, '');
}
