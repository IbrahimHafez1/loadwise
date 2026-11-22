'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { workspacePackagesAround, workspaceSourceEntry } = require('../shared/workspaces.cjs');

function isInstalled(name, fromDirectory) {
  for (let current = path.resolve(fromDirectory); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'node_modules', name))) return true;
    if (path.dirname(current) === current) return false;
  }
}

// Imports of a sibling workspace package that is not installed resolve to its source through `paths`, so rules
// see the types it exports, as in the TypeScript engine. Patterns the project declares keep their meaning.
function withWorkspaceSources(options, configDirectory) {
  const packages = workspacePackagesAround(configDirectory);
  const paths = { ...options.paths };
  const toSlashes = (filename) => filename.replaceAll('\\', '/');
  for (const [name, directory] of packages) {
    if (isInstalled(name, configDirectory)) continue;
    const entry = workspaceSourceEntry(directory, '');
    if (entry && !(name in paths)) paths[name] = [toSlashes(entry)];
    const subpaths = `${name}/*`;
    if (!(subpaths in paths))
      paths[subpaths] = [toSlashes(path.join(directory, 'src', '*')), toSlashes(path.join(directory, '*'))];
  }
  return Object.keys(paths).length ? { ...options, paths } : options;
}

module.exports = { withWorkspaceSources };
