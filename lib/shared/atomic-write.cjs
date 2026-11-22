'use strict';

// Writes user files (AGENTS.md, CLAUDE.md, the pre-commit hook, baselines) so a crash or a full disk leaves either
// the old text or the new text, never half of it.
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// `mode` sets the file's permissions; without it a replaced file keeps its own.
function writeFileAtomic(filename, text, mode) {
  // Renaming over a symlink would replace the link itself, so write where it points.
  const target = fs.existsSync(filename) ? fs.realpathSync(filename) : filename;
  const existing = fs.statSync(target, { throwIfNoEntry: false });
  // A rename would split a hard link in two; write such a file in place so every name sees the change.
  if (existing?.nlink > 1) {
    fs.writeFileSync(target, text);
    if (mode !== undefined) fs.chmodSync(target, mode);
    return;
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx' });
    // Set after creation: the umask would narrow a mode passed to the write.
    const finalMode = mode ?? existing?.mode;
    if (finalMode !== undefined) fs.chmodSync(temporary, finalMode & 0o7777);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { writeFileAtomic };
