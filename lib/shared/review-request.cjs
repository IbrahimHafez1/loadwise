// @ts-check
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const { maxReportBytes, savePendingReview } = require('./pending-review.cjs');
const path = require('node:path');

async function reportBase(project) {
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
  const root = require('./agent-init.cjs').findProjectRoot(source);
  const relative = path.relative(root, directory);
  if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
    throw new Error('Loadwise review reports must be stored outside the project.');
  return directory;
}

async function prepareReviewRequest(event, { pending = false } = {}) {
  if (
    event?.version !== 1 ||
    !['check', 'fix'].includes(event.command) ||
    !path.isAbsolute(event.directory ?? '') ||
    !event.report ||
    typeof event.report !== 'object'
  )
    throw new Error('Invalid Loadwise review event.');
  const document = JSON.stringify(event);
  if (Buffer.byteLength(document) > maxReportBytes) throw new Error('Loadwise review event exceeds the size limit.');
  const file = pending
    ? await savePendingReview(event.directory, document)
    : await saveTemporaryReport(event.directory, document);
  return { file };
}

async function saveTemporaryReport(project, document) {
  const directory = await fs.mkdtemp(path.join(await reportBase(project), 'loadwise-review-'));
  const file = path.join(directory, 'report.json');
  try {
    await fs.writeFile(file, document, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') await fs.unlink(file).catch(() => {});
    await fs.rmdir(directory).catch(() => {});
    throw error;
  }
  return file;
}

module.exports = { prepareReviewRequest };
