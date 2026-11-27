const accessibilityUsage = `Usage:
  loadwise a11y [-p tsconfig.json | -p monorepo-root [--workspace name|path ...] | file.tsx file.html file.vue ...] [--engine auto|native|js] [--loadwise-config loadwise.config.json] [--json | --format text|json|sarif|github] [--include-contextual] [--ignore rule-id] [--min-impact low|medium|high|critical] [--fail-on all|contract] [--baseline [file] | --write-baseline [file]] [--fix [--yes | --only id,...] [--no-comments] [--no-format]]
  loadwise a11y [-p tsconfig.json] (--staged | --changed-since git-ref) [--json] [--include-contextual] [--ignore rule-id]

The accessibility checker finds markup that people using screen readers, keyboards or zoom cannot use: images without alt text, unlabelled form controls, click handlers on non-interactive elements, invalid ARIA, missing page language and similar.
It reads JSX and inline Angular templates from the TypeScript program, and .html, .htm, .vue and .svelte files from the project folders (ignored folders, build output and the config's "ignore" paths are left out). Name markup files on the command line to check just those.
It shares the source check of loadwise perf: the same project discovery, config, engines, baselines and fix flags apply, and \`loadwise check\` type-checks the project once for all of them.
A project without frontend sources is skipped by \`loadwise check\` with a note; \`loadwise a11y\` on one reports 0 findings.
A loadwise.config.json "rules" and "overrides" entry for an accessibility rule applies here; findings live in the "accessibility" section of the baseline file.
--fix --only id1,id2 applies exactly those findings' fixes without asking; with --json it prints { applied, alreadyApplied, failed }.
Exit codes: 0 passed, 1 findings meeting the exit threshold, 2 invalid input or configuration.`;

export { accessibilityUsage };
