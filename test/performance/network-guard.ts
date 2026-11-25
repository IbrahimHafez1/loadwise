// Preloaded with --require: any socket connect, or a read of the URL variable from package code, is
// reported on stderr.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';

const packageRoot = path.resolve(import.meta.dirname, '../..').replaceAll('\\', '/');
const watchedVariable = 'DATABASE_URL';

function report(what: string) {
  fs.writeSync(2, '\nI1-VIOLATION ' + what + '\n');
}

net.Socket.prototype.connect = function blockedConnect() {
  report('net connect');
  throw new Error('Network access is disabled in this test.');
};
tls.connect = function blockedTlsConnect() {
  report('tls connect');
  throw new Error('Network access is disabled in this test.');
};

// Node copies the environment for child processes; only reads made by this package's own code
// count.
const selfFile = import.meta.filename.replaceAll('\\', '/');
function readByPackage() {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  const caller = frames.find((frame) => !frame.replaceAll('\\', '/').includes(selfFile));
  return Boolean(caller?.replaceAll('\\', '/').includes(packageRoot) && !caller.includes('node_modules'));
}

const environment = process.env;
process.env = new Proxy(environment, {
  get(target, key) {
    if (key === watchedVariable && readByPackage()) report('env read of ' + watchedVariable);
    return Reflect.get(target, key);
  },
  set(target, key, value) {
    Reflect.set(target, key, value);
    return true;
  },
});
