'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { files } = require('../package.json');

const source = path.resolve(__dirname, '..');
const runtime = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'loadwise-runtime-'));
for (const entry of ['package.json', 'package-lock.json', ...files]) {
  const destination = path.join(runtime, entry);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(path.join(source, entry), destination, { recursive: true });
}
console.log(runtime);
