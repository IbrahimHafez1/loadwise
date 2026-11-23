// @ts-check
'use strict';

// Use markers supplied to agent commands. IDE names, credentials and CI also occur in ordinary terminals.
function isAgentSession(env = process.env) {
  if (env.LOADWISE_AGENT !== undefined) return env.LOADWISE_AGENT === '1';
  const agent = env.AI_AGENT?.trim();
  if (agent && !/^(?:0|false|no|off|none|disabled)$/i.test(agent)) return true;
  return Boolean(
    (env.CODEX_TOOL_CALL_ID?.trim() && env.CODEX_THREAD_ID?.trim()) ||
    env.CLAUDE_CODE_CHILD_SESSION === '1' ||
    env.CURSOR_AGENT === '1' ||
    env.GEMINI_CLI === '1' ||
    env.COPILOT_AGENT === '1',
  );
}

function promptReview(args) {
  if (!isAgentSession()) return;
  const [command, subcommand] = args;
  if (['agent', 'explain', '--version', '-v'].includes(command)) return;
  if (['perf', 'maint'].includes(command) && ['editor', 'agent'].includes(subcommand)) return;
  const end = args.indexOf('--');
  const options = end === -1 ? args : args.slice(0, end);
  if (options.some((arg) => ['--help', '-h', '--watch'].includes(arg))) return;
  console.error(
    'Loadwise agent review: From the checked project, run `loadwise agent instructions` with this same CLI and follow the workflow now. Review every in-scope finding and earlier fix against the code, callers and tests. Keep check-only requests read-only. Tell the user which changes you recommend and why, flag false positives and skipped coverage, and let the user choose what to change. Use scoped `loadwise agent history` and `loadwise agent verify` to account for each outcome.',
  );
}

module.exports = { isAgentSession, promptReview };
