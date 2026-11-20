'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// fs.watch fires several raw events per save (and rename pairs for atomic writes); one short settle merges them.
const settleMs = 50;

// Watches root recursively with the built-in fs.watch and emits chokidar-style events:
// 'all' (event: 'add' | 'change' | 'unlink', relativePath), 'ready' after the initial walk, and 'error'.
// ignored(relativePath, stats) is checked for every directory and file, as fs.watch cannot exclude paths itself.
function watchTree(root, ignored) {
  const emitter = new EventEmitter();
  const knownFiles = new Map();
  const knownDirectories = new Set();
  const pendingPaths = new Set();
  let rescanPending = false;
  let settleTimer;
  let closed = false;
  let nativeWatcher;

  function fail(error) {
    if (closed) return;
    emitter.emit('error', error);
  }

  function lstat(relative) {
    return fs.promises.lstat(path.join(root, relative)).catch((error) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EPERM') return undefined;
      throw error;
    });
  }

  function emitFile(relative, stats, changed) {
    if (closed) return;
    const known = knownFiles.has(relative);
    knownFiles.set(relative, stats.mtimeMs);
    if (!known) emitter.emit('all', 'add', relative);
    else if (changed) emitter.emit('all', 'change', relative);
  }

  function forget(relative) {
    const prefix = relative + path.sep;
    for (const file of knownFiles.keys()) {
      if (file !== relative && !file.startsWith(prefix)) continue;
      knownFiles.delete(file);
      if (!closed) emitter.emit('all', 'unlink', file);
    }
    for (const directory of knownDirectories) {
      if (directory === relative || directory.startsWith(prefix)) knownDirectories.delete(directory);
    }
  }

  // Walks a directory, reporting new files (and, when compareMtime, files edited since they were last seen).
  async function walk(relative, seen, compareMtime) {
    let entries;
    try {
      entries = await fs.promises.readdir(path.join(root, relative), { withFileTypes: true });
    } catch (error) {
      if (relative === '') throw error;
      return;
    }
    knownDirectories.add(relative);
    for (const entry of entries) {
      if (closed) return;
      if (!entry.isFile() && !entry.isDirectory()) continue;
      const child = relative ? path.join(relative, entry.name) : entry.name;
      const stats = await lstat(child);
      if (!stats || ignored(child, stats)) continue;
      if (stats.isDirectory()) await walk(child, seen, compareMtime);
      else if (stats.isFile()) {
        seen?.add(child);
        emitFile(child, stats, compareMtime && knownFiles.get(child) !== stats.mtimeMs);
      }
    }
  }

  async function rescan() {
    const seen = new Set();
    await walk('', seen, true);
    for (const file of knownFiles.keys()) if (!seen.has(file)) forget(file);
  }

  async function settlePath(relative) {
    if (relative.split(path.sep).some((segment) => segment === '..')) return;
    const stats = await lstat(relative);
    if (!stats) return forget(relative);
    if (ignored(relative, stats)) return;
    if (stats.isFile()) {
      if (knownDirectories.has(relative)) forget(relative);
      return emitFile(relative, stats, true);
    }
    if (!stats.isDirectory()) return;
    if (knownFiles.has(relative)) forget(relative);
    // A new or renamed-in directory: its files may land before the watch covers it, so walk it.
    if (!knownDirectories.has(relative)) await walk(relative);
  }

  async function flush() {
    settleTimer = undefined;
    const paths = [...pendingPaths];
    pendingPaths.clear();
    const fullRescan = rescanPending;
    rescanPending = false;
    try {
      // A vanished root never reports itself reliably on every platform, so check it on each batch.
      if (!(await fs.promises.stat(root)).isDirectory()) throw new Error('Watched root is not a directory: ' + root);
      if (fullRescan) await rescan();
      else for (const relative of paths) await settlePath(relative);
    } catch (error) {
      fail(error);
    }
  }

  function queue(filename) {
    if (closed) return;
    const relative = filename ? path.normalize(filename.toString()) : '';
    // Without stats, ignored() can only reject by path, which drops events under node_modules, .git and so on.
    if (relative !== '.' && ignored(relative)) return;
    // No filename (or the root itself) means "something changed somewhere": diff the whole tree.
    if (relative === '' || relative === '.') rescanPending = true;
    else pendingPaths.add(relative);
    settleTimer ??= setTimeout(() => void flush(), settleMs);
  }

  try {
    nativeWatcher = fs.watch(root, { recursive: true, persistent: true }, (_eventType, filename) => queue(filename));
    nativeWatcher.on('error', fail);
  } catch (error) {
    process.nextTick(fail, error);
    emitter.close = async () => {
      closed = true;
    };
    return emitter;
  }

  walk('', undefined, false).then(() => {
    if (!closed) emitter.emit('ready');
  }, fail);

  emitter.close = async () => {
    closed = true;
    clearTimeout(settleTimer);
    nativeWatcher.close();
  };
  return emitter;
}

module.exports = { watchTree };
