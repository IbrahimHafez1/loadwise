import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, after } from 'node:test';

// agent init opts in on this computer. Keep integration tests out of the user's real history.
function isolateHistory() {
  const variable = process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_STATE_HOME';
  const original = process.env[variable];
  const agentMode = process.env.LOADWISE_AGENT;
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  let state: string | undefined;
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

export { isolateHistory };
