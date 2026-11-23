'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { isWithin } = require('../shared/workspaces.cjs');

const configNames = ['tsconfig.json', 'jsconfig.json'];
const aliasOptionNames = ['paths', 'pathsBasePath', 'baseUrl'];

function aliasOptionsOf(config, directory) {
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} };
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, host);
  if (!parsed?.options.paths) return;
  const coversDirectory = parsed.fileNames.some((file) => isWithin(directory, file));
  if (!coversDirectory) return;
  return Object.fromEntries(aliasOptionNames.map((name) => [name, parsed.options[name]]));
}

// The path aliases of the nearest ancestor config above the scanned folder that covers files under it, such as a
// repository tsconfig whose `paths` the scanned subfolder's own config does not repeat. The search ends at the
// repository root, where `.git` lives.
function ancestorAliasOptions(directory) {
  let current = path.resolve(directory);
  while (!fs.existsSync(path.join(current, '.git'))) {
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
    const config = configNames
      .map((name) => path.join(current, name))
      .find((candidate) => ts.sys.fileExists(candidate));
    const aliases = config && aliasOptionsOf(config, directory);
    if (aliases) return aliases;
  }
}

module.exports = { ancestorAliasOptions };
