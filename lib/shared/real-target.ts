import fs from 'node:fs';
import path from 'node:path';

// Resolve links even when a proposed destination's parent directory does not exist yet (including
// dangling symlinks).
function realTarget(filename: string, depth = 0): string {
  if (depth > 40) throw new Error('Too many levels of symbolic links');
  try {
    return fs.realpathSync.native(filename);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT' || path.dirname(filename) === filename) throw error;
    const link = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (link?.isSymbolicLink()) {
      const target = path.resolve(path.dirname(filename), fs.readlinkSync(filename));
      return realTarget(target, depth + 1);
    }
    return path.join(realTarget(path.dirname(filename), depth), path.basename(filename));
  }
}

export { realTarget };
