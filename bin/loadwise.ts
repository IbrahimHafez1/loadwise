#!/usr/bin/env node
import packageManifest from '../package.json' with { type: 'json' };
const { version } = packageManifest;
import { respawnWithLargerHeap, shouldRespawnWithLargerHeap } from '../lib/shared/heap-limit.js';

const usage = `Usage:
  loadwise [check] [directory] [--only perf,rel,maint,sec,a11y | --skip perf,rel,maint,sec,a11y] [--json | --format text|json|sarif|github] [--include-contextual] [--staged | --changed-since git-ref] [--fail-on contract|all] [--min-impact low|medium|high|critical] [--config loadwise.config.json] [--ignore rule-id] [--workspace name|path ...] [--online] [--baseline [file] | --write-baseline [file]]
  loadwise perf [args...]
  loadwise rel [args...]
  loadwise maint [args...]
  loadwise sec [args...]
  loadwise a11y [args...]
  loadwise fix --yes [--json]
  loadwise fix --all [performance] [reliability] [maintainability] [security] [accessibility] [--json]
  loadwise fix --handoff [performance] [reliability] [maintainability] [security] [accessibility]
  loadwise explain <rule-id>
  loadwise --version
  loadwise agent init [--mode ask|auto] [--hook [block|warn|off]]
  loadwise agent instructions
  loadwise agent mcp [directory] [--print-config]
  loadwise agent pending
  loadwise agent history [performance] [reliability] [maintainability] [security] [accessibility]
  loadwise agent verify [--save] [--checker perf|rel|maint|sec|a11y] --outcomes outcomes.json report.json [more-reports.json ...]

check, the default command, runs every checker (perf: performance, rel: reliability, maint: maintainability, sec: security, a11y: accessibility) on one directory (default: the current folder) and prints one titled report per checker, in that order. The accessibility checker reads JSX, HTML, Vue, Svelte and Angular templates and skips itself on a project without any.
--only runs just the listed checkers and --skip runs all but them; both take a comma-separated list, and they cannot be combined.
loadwise.config.json in the directory (or --config <file>) sets the default checkers, ignored paths, per-rule levels (off, warn, error) and each checker's policy; flags beat it. --ignore drops a rule's findings and can repeat.
The performance, reliability and security checkers use the directory's tsconfig.json or jsconfig.json; in a monorepo root without one it checks every workspace package's config in one report (--workspace limits the checkers to named packages or folders); standalone JavaScript-only packages can use check and fix without a source config.
--json prints one key per selected checker, { "performance": report, "reliability": report, "maintainability": report, "security": report, "accessibility": report }; a skipped or failed checker's report is null.
--online adds the security checker's dependency vulnerability check, which sends package names and versions from the lockfile to the OSV database; without it the check is skipped with a note.
--format sarif prints SARIF 2.1.0 with one run per checker for GitHub code scanning; --format github prints workflow annotations (::warning, ::error); --json is --format json.
--include-contextual, --staged, --changed-since, --fail-on and --min-impact apply to every selected checker; without --fail-on each keeps its own default.
--write-baseline records every selected checker's current findings in one file (default loadwise-baseline.json in the checked directory, a section per checker); --baseline reports only findings not in it and prints how many were hidden ("baselineHidden" in --json). Fixed findings leave the file on the next --write-baseline.
check never changes source files: apply fixes with the printed \`loadwise perf --fix --only id\`, \`loadwise rel --fix --only id\`, \`loadwise maint --fix --only id\` \`loadwise sec --fix --only id\` and \`loadwise a11y --fix --only id\` commands.
fix --yes applies automatic edits. fix --all also applies edits marked for review. Both accept checker names, for example loadwise fix --all performance security. With no names, both use the project's configured checkers.
fix --json with --yes or --all records the applied hunks and outstanding findings in its output for review.
perf, rel, maint, sec and a11y run one checker with its full command set; \`loadwise perf --help\`, \`loadwise rel --help\`, \`loadwise maint --help\` \`loadwise sec --help\` and \`loadwise a11y --help\` list their commands and flags.
explain prints the rule's default impact, description and an illustrative change when available.
Recognized coding-agent sessions receive review instructions automatically. agent instructions prints the review workflow. Optional agent init writes it into AGENTS.md and imports it from CLAUDE.md.
An active agent can run check --json directly or use the loadwise_check MCP tool for a fresh offline report.
Add --review to a combined check or bulk fix to keep its original report and print the same handoff for any coding agent. agent pending lists saved handoffs for this project.
agent init --hook installs one git pre-commit hook that runs \`loadwise check --staged\`: block fails the commit on findings, warn only prints them, off removes the hook. --hook alone means warn.
Exit codes: 0 passed, 1 a checker met its exit threshold, 2 invalid input or configuration in any checker.`;

// Each command loads only the code it needs, so a quick `--version` or `explain` does not pay for
// the scanners.
async function main(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'perf') return (await import('../lib/performance/cli.js')).main(rest);
  if (command === 'rel') return (await import('../lib/reliability/cli.js')).main(rest);
  if (command === 'maint') return (await import('../lib/maintainability/cli.js')).main(rest);
  if (command === 'sec') return (await import('../lib/security/cli.js')).main(rest);
  if (command === 'a11y') return (await import('../lib/accessibility/cli.js')).main(rest);
  if (command === 'fix') return (await import('../lib/shared/fix.js')).runFix(rest);
  if (command === 'explain') return (await import('../lib/shared/explain.js')).runExplain(rest);
  if (command === '--version' || command === '-v') {
    if (rest.length) throw new Error('Usage: loadwise --version');
    console.log(version);
    return 0;
  }
  if (command === 'agent') return (await import('../lib/shared/agent-init.js')).runAgentCommand(rest);
  if (command === '--help' || command === '-h') {
    console.log(usage);
    return 0;
  }
  return (await import('../lib/shared/check.js')).runCheck(command === 'check' ? rest : args, usage);
}

// perf, rel, maint, sec and a11y run in this process, whose default heap limit is too small for very large
// projects. One re-spawn with a larger limit keeps their output and exit code the same; a limit the
// user set is never replaced.
const inProcessCheckers = new Set(['perf', 'rel', 'maint', 'sec', 'a11y']);

function respawnIfHeapTooSmall(commandArgs: readonly string[]): boolean {
  if (!inProcessCheckers.has(commandArgs[0]) || !shouldRespawnWithLargerHeap()) return false;
  respawnWithLargerHeap(import.meta.filename, commandArgs);
  return true;
}

function runMain(commandArgs: readonly string[]): void {
  main(commandArgs)
    .then(async (code) => {
      process.exitCode = code;
      (await import('../lib/shared/agent-session.js')).promptReview(commandArgs);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
}

const args = process.argv.slice(2);
if (!respawnIfHeapTooSmall(args)) runMain(args);
