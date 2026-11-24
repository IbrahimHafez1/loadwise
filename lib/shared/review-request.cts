// @ts-check
import fs from 'node:fs/promises';
import os from 'node:os';
import { maxReportBytes, savePendingReview } from './pending-review.cjs';
import path from 'node:path';
import type { ReviewEvent, ReviewHandoffReceipt } from './types/review-event.cjs';
import { findProjectRoot } from './agent-init.cjs';

async function reportBase(project: string): Promise<string> {
  // Windows temp settings can point at a machine-wide folder. LocalAppData inherits the user's ACL.
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : os.tmpdir();
  if (!path.isAbsolute(base)) throw new Error('Expected an absolute user storage directory.');
  const stat = await fs.lstat(base);
  if (!stat.isDirectory()) throw new Error('Expected a directory for private Loadwise reports.');
  if (process.getuid) {
    const trustedOwner = stat.uid === process.getuid() || stat.uid === 0;
    const unsafeSharedDirectory = stat.mode & 0o022 && !(stat.mode & 0o1000);
    if (!trustedOwner || unsafeSharedDirectory) throw new Error('Unsafe directory for private Loadwise reports.');
  }
  const [source, directory] = await Promise.all([fs.realpath(project), fs.realpath(base)]);
  const root = findProjectRoot(source);
  const relative = path.relative(root, directory);
  if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
    throw new Error('Loadwise review reports must be stored outside the project.');
  return directory;
}

async function prepareReviewRequest(
  event: ReviewEvent,
  { pending = false }: { pending?: boolean } = {},
): Promise<ReviewHandoffReceipt> {
  const { directory } = event;
  if (
    event?.version !== 1 ||
    !['check', 'fix'].includes(event.command) ||
    directory === undefined ||
    !path.isAbsolute(directory) ||
    !event.report ||
    typeof event.report !== 'object'
  )
    throw new Error('Invalid Loadwise review event.');
  const document = JSON.stringify(event);
  if (Buffer.byteLength(document) > maxReportBytes) throw new Error('Loadwise review event exceeds the size limit.');
  const file = pending ? await savePendingReview(directory, document) : await saveTemporaryReport(directory, document);
  return { file };
}

async function saveTemporaryReport(project: string, document: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(await reportBase(project), 'loadwise-review-'));
  const file = path.join(directory, 'report.json');
  try {
    await fs.writeFile(file, document, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    const alreadyExists = error instanceof Error && 'code' in error && error.code === 'EEXIST';
    if (!alreadyExists) await fs.unlink(file).catch(() => {});
    await fs.rmdir(directory).catch(() => {});
    throw error;
  }
  return file;
}

export { prepareReviewRequest };
