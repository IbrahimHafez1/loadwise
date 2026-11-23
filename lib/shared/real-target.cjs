'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Resolve links even when a proposed destination's parent directory does not exist yet (including dangling symlinks).
function realTarget(filename, depth = 0) {
  if (depth > 40) throw new Error('Too many levels of symbolic links');
  try {
    return fs.realpathSync.native(filename);
  } catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(filename) === filename) throw error;
    const link = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (link?.isSymbolicLink()) {
      const target = path.resolve(path.dirname(filename), fs.readlinkSync(filename));
      return realTarget(target, depth + 1);
    }
    return path.join(realTarget(path.dirname(filename), depth), path.basename(filename));
  }
}

module.exports = { realTarget };
