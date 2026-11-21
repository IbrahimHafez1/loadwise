'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, after } = require('node:test');

// agent init opts in on this computer. Keep integration tests out of the user's real history.
function isolateHistory() {
  const variable = process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_STATE_HOME';
  const original = process.env[variable];
  const agentMode = process.env.LOADWISE_AGENT;
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  let state;
  before(() => {
    fs.mkdirSync(base, { recursive: true });
    state = fs.mkdtempSync(path.join(base, 'loadwise-state-'));
    process.env[variable] = state;
    process.env.LOADWISE_AGENT = '0';
  });
  after(() => {
    if (original === undefined) delete process.env[variable];
    else process.env[variable] = original;
    if (agentMode === undefined) delete process.env.LOADWISE_AGENT;
    else process.env.LOADWISE_AGENT = agentMode;
    if (state) fs.rmSync(state, { recursive: true, force: true });
  });
}

module.exports = { isolateHistory };
