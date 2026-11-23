// @ts-check
'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');

// Resolve the upstream package's own exports from its vendored location. Its
// executable stays in the official optional package for this OS and CPU.
const requireNative = createRequire(path.join(__dirname, 'vendor/typescript/package.json'));

function executable() {
  try {
    const filename = requireNative('./lib/getExePath.js').default();
    const binaryPackage = require(path.resolve(path.dirname(filename), '../package.json'));
    const expected = requireNative('./package.json').version;
    if (binaryPackage.version !== expected)
      throw new Error(`Expected version ${expected}, found ${binaryPackage.version}.`);
    return filename;
  } catch (error) {
    throw new Error(
      '--native requires the official TypeScript binary for this platform. Run npm install --include=optional. ' +
        error.message,
    );
  }
}

module.exports = { requireNative, executable };
