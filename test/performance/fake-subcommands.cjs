'use strict';

// Preloaded with --require: stands in for the migrations and db command modules so dispatch is tested on its own.
const Module = require('node:module');
const path = require('node:path');

const libraryRoot = path.resolve(__dirname, '../../lib/performance');
const fakes = new Map(['migrations', 'db'].map((command) => [path.join(libraryRoot, command, 'cli.cjs'), command]));
const resolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveFake(request, parent, ...rest) {
  const candidate = parent?.filename && path.resolve(path.dirname(parent.filename), request);
  if (!fakes.has(candidate)) return resolveFilename.call(this, request, parent, ...rest);
  process.stderr.write('fake loaded: ' + fakes.get(candidate) + '\n');
  if (!require.cache[candidate]) {
    const fake = new Module(candidate);
    fake.loaded = true;
    fake.exports = {
      async run(argv) {
        console.log(JSON.stringify({ command: fakes.get(candidate), argv }));
        return 3;
      },
    };
    require.cache[candidate] = fake;
  }
  return candidate;
};
