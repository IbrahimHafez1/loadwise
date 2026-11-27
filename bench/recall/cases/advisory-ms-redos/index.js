// Pre-fix shape of ms@0.7.0 parse() (CVE-2015-8315, GHSA-3fx5-fwvr-xrjg): the unanchored-tail regex backtracks on long digit runs.
const unitPattern =
  /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i;

module.exports = function parse(input) {
  return unitPattern.exec(String(input));
};
