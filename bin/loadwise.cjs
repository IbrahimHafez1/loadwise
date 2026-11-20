#!/usr/bin/env node
'use strict';

const usage = `Usage:
  loadwise [check] [directory] [--only perf,maint,sec | --skip perf,maint,sec] [--json] [--include-contextual] [--staged | --changed-since git-ref] [--fail-on contract|all]
  loadwise perf [args...]
  loadwise maint [args...]
  loadwise sec [args...]
  loadwise agent init [--mode ask|auto] [--hook [block|warn|off]]

check, the default command, runs every checker (perf: performance, maint: maintainability, sec: security) on one directory (default: the current folder) and prints one titled report per checker, in that order.
--only runs just the listed checkers and --skip runs all but them; both take a comma-separated list, and they cannot be combined.
The performance checker uses the directory's tsconfig.json or jsconfig.json; without one it is skipped with a note.
--json prints one key per selected checker, { "performance": report, "maintainability": report, "security": report }; a skipped or failed checker's report is null.
--include-contextual, --staged, --changed-since and --fail-on apply to every selected checker; without --fail-on each keeps its own default.
Security checks are not available yet: \`loadwise sec\` and --only sec exit with code 2.
check never changes files: apply fixes with the printed \`loadwise perf --fix --only id\` and \`loadwise maint --fix --only id\` commands.
perf, maint and sec run one checker with its full command set; \`loadwise perf --help\` and \`loadwise maint --help\` list their commands and flags.
agent init writes one block of instructions for AI coding agents, covering both checkers, into AGENTS.md and imports it from CLAUDE.md.
agent init --hook installs one git pre-commit hook that runs \`loadwise check --staged\`: block fails the commit on findings, warn only prints them, off removes the hook. --hook alone means warn.
Exit codes: 0 passed, 1 a checker met its exit threshold, 2 invalid input or configuration in any checker.`;

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'perf') return require('../lib/performance/cli.cjs').main(rest);
  if (command === 'maint') return require('../lib/maintainability/cli.cjs').main(rest);
  if (command === 'sec') throw new Error(require('../lib/shared/pillars.cjs').unavailablePillars.get('sec'));
  if (command === 'agent') return require('../lib/shared/agent-init.cjs').runAgentCommand(rest);
  if (command === '--help' || command === '-h') {
    console.log(usage);
    return 0;
  }
  return require('../lib/shared/check.cjs').runCheck(command === 'check' ? rest : args, usage);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
