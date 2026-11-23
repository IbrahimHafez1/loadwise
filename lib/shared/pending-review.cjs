// @ts-check
'use strict';

const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { findProjectRoot } = require('./agent-init.cjs');
const { pendingReviewStorage } = require('./fix-history.cjs');

const maxReportBytes = 16 * 1024 * 1024;

async function savePendingReview(directory, document) {
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

function isPrivate(stat) {
  return !stat.isSymbolicLink() && (!process.getuid || (stat.uid === process.getuid() && !(stat.mode & 0o077)));
}

const receiptIdPattern = /^run-\d+-[a-zA-Z0-9]{6}$/;

async function readReceipt(inbox, name) {
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
    const event = JSON.parse(await handle.readFile('utf8'));
    if (
      event?.version !== 1 ||
      !['check', 'fix'].includes(event.command) ||
      typeof event.directory !== 'string' ||
      !path.isAbsolute(event.directory) ||
      event.directory.split(process.platform === 'win32' ? /[\\/]/ : '/').includes('..') ||
      !event.report ||
      typeof event.report !== 'object'
    )
      return;
    const reportRoot = findProjectRoot(await fs.realpath(event.directory));
    if (path.relative(inbox.root, reportRoot)) return;
    return { receipt, event };
  } finally {
    await handle.close();
  }
}

async function pendingReviews(directory) {
  const inbox = pendingReviewStorage(directory, false);
  if (!inbox) return [];
  const receipts = [];
  for (const name of (await fs.readdir(inbox.directory)).sort()) {
    if (!receiptIdPattern.test(name)) continue;
    try {
      const entry = await readReceipt(inbox, name);
      if (entry) receipts.push(entry.receipt);
    } catch (error) {
      // The agent can remove a reviewed receipt between enumeration and opening. Ignore malformed data.
      if (!(error instanceof SyntaxError) && !['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  return receipts;
}

async function readPendingReview(directory, id) {
  if (typeof id !== 'string' || !receiptIdPattern.test(id)) return;
  const inbox = pendingReviewStorage(directory, false);
  if (!inbox) return;
  try {
    return (await readReceipt(inbox, id))?.event;
  } catch (error) {
    if (!(error instanceof SyntaxError) && !['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) throw error;
  }
}

module.exports = { savePendingReview, pendingReviews, readPendingReview, maxReportBytes };
