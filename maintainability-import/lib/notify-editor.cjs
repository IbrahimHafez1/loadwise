'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Both standalone CLIs use the same empty-file refresh protocol.
function signalDirectory(root) {
  let canonical = fs.realpathSync.native(root);
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const user = String(process.getuid?.() ?? os.homedir());
  const key = createHash('sha256').update(user).update('\0').update(canonical).digest('hex');
  return path.join(fs.realpathSync.native(os.tmpdir()), 'backend-checkers-' + key);
}

function isPrivateDirectory(directory) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  return stat?.isDirectory() && (!process.getuid || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0));
}

function requestRefresh(root) {
  const directory = signalDirectory(root);
  if (!isPrivateDirectory(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^watch-[0-9a-f]{32}$/.test(entry.name)) continue;
    try {
      fs.unlinkSync(path.join(directory, entry.name));
    } catch {
      // A second CLI or the closing editor may already have removed the registration.
    }
  }
}

function notifyEditor(input) {
  if (process.env.BACKEND_CHECKERS_EDITOR_SCAN === '1') return;
  try {
    const canonical = fs.realpathSync.native(input);
    const root = fs.statSync(canonical).isDirectory() ? canonical : path.dirname(canonical);
    requestRefresh(root);
    // Running a nested config from a workspace root should also refresh that workspace.
    const cwd = fs.realpathSync.native(process.cwd());
    const relative = path.relative(cwd, root);
    if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
      requestRefresh(cwd);
  } catch {
    // Temp storage and editor availability must never affect a terminal or CI result.
  }
}

module.exports = { signalDirectory, isPrivateDirectory, notifyEditor };
