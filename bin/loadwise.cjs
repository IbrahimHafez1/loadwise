#!/usr/bin/env node
'use strict';

const usage = `Usage:
  loadwise [check] [directory] [--json] [--include-contextual] [--staged | --changed-since git-ref] [--fail-on contract|all]
  loadwise perf [args...]
  loadwise maint [args...]
  loadwise agent init [--mode ask|auto] [--hook [block|warn|off]]

check, the default command, runs the performance and maintainability checkers on one directory (default: the current folder) and prints both reports.
The performance checker uses the directory's tsconfig.json or jsconfig.json; without one it is skipped with a note.
--json prints { "performance": report, "maintainability": report }; a skipped or failed checker's report is null.
--fail-on applies to both checkers; without it each keeps its own default.
check never changes files: apply fixes with the printed \`loadwise perf --fix --only id\` and \`loadwise maint --fix --only id\` commands.
perf runs only the performance checker and maint only the maintainability checker; \`loadwise perf --help\` and \`loadwise maint --help\` list their commands and flags.
agent init writes one block of instructions for AI coding agents, covering both checkers, into AGENTS.md and imports it from CLAUDE.md.
agent init --hook installs one git pre-commit hook that runs \`loadwise check --staged\`: block fails the commit on findings, warn only prints them, off removes the hook. --hook alone means warn.
Exit codes: 0 passed, 1 a checker met its exit threshold, 2 invalid input or configuration in either checker.`;

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'perf') return require('../lib/performance/cli.cjs').main(rest);
  if (command === 'maint') return require('../lib/maintainability/cli.cjs').main(rest);
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
