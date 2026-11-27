import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let cachedTempDirectory: string | undefined;

function realDirectory(directory: string): string {
  try {
    return fs.realpathSync.native(directory);
  } catch {
    return path.resolve(directory);
  }
}

function realTemporaryDirectory(): string {
  cachedTempDirectory ??= realDirectory(os.tmpdir());
  return cachedTempDirectory;
}

/**
 * Checks whether `target` exists without throwing on sandboxed or restricted parent directories.
 */
function safeExists(target: string): boolean {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

/**
 * Returns true when `directory` resolves to the OS temporary root, stopping upward project walks
 * so a manifest above `os.tmpdir()` never claims throwaway temp projects.
 */
function isTempRoot(directory: string): boolean {
  return realDirectory(directory) === realTemporaryDirectory();
}

export { isTempRoot, safeExists };
