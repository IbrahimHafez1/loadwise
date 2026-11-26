// Writes user files (AGENTS.md, CLAUDE.md, the pre-commit hook, baselines) so a crash or a full disk leaves either
// the old text or the new text, never half of it.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { errorCode } from './error-code.js';

const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80];
const SLEEP_LOCK = new Int32Array(new SharedArrayBuffer(4));

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code && TRANSIENT_RENAME_ERRORS.has(code) && attempt < RENAME_RETRY_DELAYS_MS.length) {
        Atomics.wait(SLEEP_LOCK, 0, 0, RENAME_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw error;
    }
  }
}

// `mode` sets the file's permissions; without it a replaced file keeps its own.
function writeFileAtomic(filename: string, text: string, mode?: number) {
  // Renaming over a symlink would replace the link itself, so write where it points.
  const target = fs.existsSync(filename) ? fs.realpathSync(filename) : filename;
  const existing = fs.statSync(target, { throwIfNoEntry: false });
  // A rename would split a hard link in two; write such a file in place so every name sees the
  // change.
  if (existing && existing.nlink > 1) {
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
    renameWithRetry(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export { renameWithRetry, writeFileAtomic };
