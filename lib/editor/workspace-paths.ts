// Whether a path stays inside a workspace folder. Reads only need the lexical check; anything the
// server writes, or asks the editor to write, also resolves symbolic links, so a link inside the
// folder cannot send the write elsewhere.
import path from 'node:path';
import { realTarget } from '../shared/real-target.js';

function isInside(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

/** Whether `filename`, with every link on its path resolved, is inside the real folder `root`. */
function isRealPathInside(root: string, filename: string): boolean {
  if (!isInside(root, filename)) return false;
  try {
    return isInside(realTarget(root), realTarget(filename));
  } catch {
    // A link loop or an unreadable folder: the target cannot be shown to stay inside.
    return false;
  }
}

export { isInside, isRealPathInside };
