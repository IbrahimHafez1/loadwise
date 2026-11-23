// Pre-fix minimist@1.2.0 setKey shape (CVE-2020-7598, GHSA-vh95-rmgr-6w4m): walks a dotted key path without blocking __proto__.
function setKey(target, keyPath, value) {
  let current = target;
  for (let index = 0; index < keyPath.length - 1; index++) {
    const key = keyPath[index];
    if (current[key] === undefined) current[key] = {};
    current = current[key];
  }
  current[keyPath[keyPath.length - 1]] = value;
}

module.exports = function parseArgs(args) {
  const parsed = {};
  for (const arg of args) {
    const [rawKey, value] = arg.replace(/^--/, '').split('=');
    setKey(parsed, rawKey.split('.'), value);
  }
  return parsed;
};
