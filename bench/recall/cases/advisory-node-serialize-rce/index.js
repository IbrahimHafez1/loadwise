// Pre-fix node-serialize@0.0.4 unserialize (CVE-2017-5941): evaluates attacker-supplied strings with eval.
exports.unserialize = function unserialize(serialized) {
  const FUNCTION_FLAG = '_$$ND_FUNC$$_';
  return JSON.parse(serialized, (key, value) => {
    if (typeof value === 'string' && value.startsWith(FUNCTION_FLAG)) {
      return eval('(' + value.slice(FUNCTION_FLAG.length) + ')');
    }
    return value;
  });
};
