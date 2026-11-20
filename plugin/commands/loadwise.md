---
description: Run loadwise (performance and maintainability) and summarize the findings
argument-hint: "[directory] [--only perf,maint] [--staged]"
allowed-tools: Bash(npx loadwise:*), Bash(node_modules/.bin/loadwise:*)
---

Run `loadwise check --json $ARGUMENTS` from the project root. Use `node_modules/.bin/loadwise` when it exists, otherwise `npx loadwise`.

Then:

1. Summarize the findings per checker as a short table: id, rule, file:line, one-line meaning.
2. For each finding with a fix, show the command `loadwise perf --fix --only <id>` or `loadwise maint --fix --only <id>`, as printed in the report.
3. Ask which fixes to apply. Apply only the ones approved, and ask before changing `duplicate-implementation` or `dependency-cycle` findings, which are design decisions.
4. Never edit files before approval, and do not dismiss findings without a `// loadwise-reviewed <rule-id> -- <reason>` comment the user agreed to.
