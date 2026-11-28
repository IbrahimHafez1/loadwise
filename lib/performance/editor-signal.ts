import fs from 'node:fs';
import path from 'node:path';
import type { FSWatcher } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { signalDirectory, isPrivateDirectory, notifyEditor } from '../shared/notify-editor.js';

function listenForEditorRefresh(root: string, onRequest: () => void): { close(): void } {
  let watcher: FSWatcher | undefined;
  let directory: string | undefined;
  let registration: string | undefined;
  const name = 'watch-' + randomUUID().replaceAll('-', '');
  function close() {
    watcher?.close();
    watcher = undefined;
    if (!registration || directory === undefined) return;
    try {
      if (isPrivateDirectory(directory)) fs.rmSync(registration, { force: true });
    } catch {
      // Temp cleanup may race shutdown. Keep the directory for other listeners re-arming their registrations.
    }
    registration = undefined;
  }
  try {
    const signalFolder = signalDirectory(root);
    directory = signalFolder;
    fs.mkdirSync(signalFolder, { recursive: true, mode: 0o700 });
    if (!isPrivateDirectory(signalFolder)) return { close };
    const file = path.join(signalFolder, name);
    watcher = fs.watch(signalFolder, { persistent: false }, (_event, changed) => {
      if (!registration || (changed && changed !== name)) return;
      try {
        if (!isPrivateDirectory(signalFolder)) return close();
        // A removed registration is one request. Re-arm before scanning to coalesce concurrent
        // CLIs.
        fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) close();
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

export { listenForEditorRefresh, notifyEditor };
