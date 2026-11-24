// @ts-check
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findProjectRoot } from './agent-init.cjs';
import { pendingReviewStorage } from './fix-history.cjs';
import type { HistoryStorage } from './types/review-history.cjs';
import type { ReviewEvent } from './types/review-event.cjs';

interface PendingReceipt {
  receipt: string;
  event: ReviewEvent & { directory: string };
}

const ignorableReceiptCodes = ['ENOENT', 'ELOOP', 'ENOTDIR'];

const maxReportBytes = 16 * 1024 * 1024;

async function savePendingReview(directory: string, document: string): Promise<string> {
  if (Buffer.byteLength(document) > maxReportBytes) throw new Error('Loadwise report exceeds the size limit.');
  const inbox = pendingReviewStorage(directory, true);
  const envelope = await fs.mkdtemp(path.join(inbox.directory, 'run-' + Date.now() + '-'));
  const temporary = path.join(envelope, 'writing');
  const receipt = path.join(envelope, 'report.json');
  try {
    await fs.writeFile(temporary, document, { flag: 'wx', mode: 0o600 });
    // Readers can enumerate the inbox while another terminal is writing the same project's report.
    await fs.rename(temporary, receipt);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    await fs.rmdir(envelope);
    throw error;
  }
  return receipt;
}

function isPrivate(stat: Stats): boolean {
  return !stat.isSymbolicLink() && (!process.getuid || (stat.uid === process.getuid() && !(stat.mode & 0o077)));
}

const receiptIdPattern = /^run-\d+-[a-zA-Z0-9]{6}$/;

// The agent can remove a reviewed receipt between enumeration and opening. Malformed data is
// ignored too.
function isIgnorableReceiptError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    ignorableReceiptCodes.includes(error.code)
  );
}

function isPendingEvent(event: unknown): event is ReviewEvent & { directory: string } {
  return (
    typeof event === 'object' &&
    event !== null &&
    'version' in event &&
    event.version === 1 &&
    'command' in event &&
    typeof event.command === 'string' &&
    ['check', 'fix'].includes(event.command) &&
    'directory' in event &&
    typeof event.directory === 'string' &&
    path.isAbsolute(event.directory) &&
    !event.directory.split(process.platform === 'win32' ? /[\\/]/ : '/').includes('..') &&
    'report' in event &&
    Boolean(event.report) &&
    typeof event.report === 'object'
  );
}

async function readReceipt(inbox: HistoryStorage, name: string): Promise<PendingReceipt | undefined> {
  const envelope = path.join(inbox.directory, name);
  const receipt = path.join(envelope, 'report.json');
  const parent = await fs.lstat(envelope);
  if (!parent.isDirectory() || !isPrivate(parent)) return;
  const stat = await fs.lstat(receipt);
  if (!stat.isFile() || !isPrivate(stat) || stat.nlink !== 1 || stat.size > maxReportBytes) return;
  const handle = await fs.open(receipt, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (stat.ino !== opened.ino || stat.dev !== opened.dev) return;
    const event: unknown = JSON.parse(await handle.readFile('utf8'));
    if (!isPendingEvent(event)) return;
    const reportRoot = findProjectRoot(await fs.realpath(event.directory));
    if (path.relative(inbox.root, reportRoot)) return;
    return { receipt, event };
  } finally {
    await handle.close();
  }
}

async function pendingReviews(directory: string): Promise<string[]> {
  const inbox = pendingReviewStorage(directory, false);
  if (!inbox) return [];
  const receipts: string[] = [];
  for (const name of (await fs.readdir(inbox.directory)).sort()) {
    if (!receiptIdPattern.test(name)) continue;
    try {
      const entry = await readReceipt(inbox, name);
      if (entry) receipts.push(entry.receipt);
    } catch (error) {
      if (!isIgnorableReceiptError(error)) throw error;
    }
  }
  return receipts;
}

async function readPendingReview(directory: string, id: unknown): Promise<ReviewEvent | undefined> {
  if (typeof id !== 'string' || !receiptIdPattern.test(id)) return;
  const inbox = pendingReviewStorage(directory, false);
  if (!inbox) return;
  try {
    return (await readReceipt(inbox, id))?.event;
  } catch (error) {
    if (!isIgnorableReceiptError(error)) throw error;
  }
}

export { savePendingReview, pendingReviews, readPendingReview, maxReportBytes };
