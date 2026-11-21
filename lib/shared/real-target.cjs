'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Resolve links even when a proposed destination's parent directory does not exist yet.
function realTarget(filename) {
  try {
    return fs.realpathSync.native(filename);
  } catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(filename) === filename) throw error;
    return path.join(realTarget(path.dirname(filename)), path.basename(filename));
  }
}

module.exports = { realTarget };
