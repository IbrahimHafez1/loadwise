import assert from 'node:assert/strict';
import test from 'node:test';
import { isAgentSession } from '../../lib/shared/agent-session.js';

test('agent tool calls and cross-vendor agent names activate the review', () => {
  for (const marker of ['CLAUDE_CODE_CHILD_SESSION', 'CURSOR_AGENT', 'GEMINI_CLI', 'COPILOT_AGENT']) {
    assert.equal(isAgentSession({ [marker]: '1' }), true, marker);
    assert.equal(isAgentSession({ [marker]: '0' }), false, marker);
  }
  assert.equal(isAgentSession({ CODEX_THREAD_ID: 'thread', CODEX_TOOL_CALL_ID: 'call' }), true);
  for (const name of ['github_copilot_vscode_agent', 'opencode', 'custom-agent']) {
    assert.equal(isAgentSession({ AI_AGENT: name }), true, name);
  }
});

test('ordinary terminals, CI and disabled agent markers keep the manual workflow', () => {
  assert.equal(isAgentSession({}), false);
  assert.equal(isAgentSession({ TERM_PROGRAM: 'vscode', CLAUDECODE: '1', OPENCODE_TERMINAL: '1' }), false);
  assert.equal(isAgentSession({ CI: 'true', AGENT: '1' }), false);
  assert.equal(isAgentSession({ CODEX_THREAD_ID: 'thread' }), false);
  assert.equal(isAgentSession({ CODEX_TOOL_CALL_ID: 'call' }), false);
  assert.equal(isAgentSession({ CODEX_THREAD_ID: 'thread', CODEX_TOOL_CALL_ID: ' ' }), false);
  for (const disabled of ['', '   ', '0', ' FALSE ', 'no', 'off', 'none', 'disabled']) {
    assert.equal(isAgentSession({ AI_AGENT: disabled }), false, disabled);
  }
});

test('an explicit Loadwise override takes precedence over detected markers', () => {
  assert.equal(isAgentSession({ LOADWISE_AGENT: '1' }), true);
  assert.equal(isAgentSession({ LOADWISE_AGENT: '0', AI_AGENT: 'opencode', CURSOR_AGENT: '1' }), false);
});
