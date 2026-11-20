'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { signalDirectory, isPrivateDirectory, notifyEditor } = require('./notify-editor.cjs');

function listenForEditorRefresh(root, onRequest) {
  let watcher;
  let directory;
  let registration;
  const name = 'watch-' + randomUUID().replaceAll('-', '');
  function close() {
    watcher?.close();
    watcher = undefined;
    if (!registration) return;
    try {
      if (isPrivateDirectory(directory)) fs.rmSync(registration, { force: true });
    } catch {
      // Temp cleanup may race shutdown. Keep the directory for other listeners re-arming their registrations.
    }
    registration = undefined;
  }
  try {
    directory = signalDirectory(root);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!isPrivateDirectory(directory)) return { close };
    const file = path.join(directory, name);
    watcher = fs.watch(directory, { persistent: false }, (_event, changed) => {
      if (!registration || (changed && changed !== name)) return;
      try {
        if (!isPrivateDirectory(directory)) return close();
        // A removed registration is one request. Re-arm before scanning to coalesce concurrent CLIs.
        fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') close();
        return;
      }
      onRequest();
    });
    watcher.on('error', close);
    fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    registration = file;
  } catch {
    close();
  }
  return { close };
}

module.exports = { listenForEditorRefresh, notifyEditor };
