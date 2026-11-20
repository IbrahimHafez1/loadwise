'use strict';

// Preloaded with --require: any socket connect, or a read of the URL variable from package code, is reported on stderr.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');

const packageRoot = path.resolve(__dirname, '../..');
const watchedVariable = 'DATABASE_URL';

function report(what) {
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

// Node copies the environment for child processes; only reads made by this package's own code count.
function readByPackage() {
  const frames = new Error().stack.split('\n').slice(1);
  const caller = frames.find((frame) => !frame.includes(__filename));
  return Boolean(caller?.includes(packageRoot) && !caller.includes('node_modules'));
}

const environment = process.env;
process.env = new Proxy(environment, {
  get(target, key) {
    if (key === watchedVariable && readByPackage()) report('env read of ' + watchedVariable);
    return target[key];
  },
  set(target, key, value) {
    target[key] = value;
    return true;
  },
});
