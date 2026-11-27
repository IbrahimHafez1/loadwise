---
description: Check a project or fix its Loadwise findings in this session
argument-hint: "[directory] [--only perf,rel,maint,sec,a11y] [--staged] | fix [--yes|--all|--handoff] [performance reliability maintainability security accessibility]"
allowed-tools: Bash(npx loadwise:*), Bash(node_modules/.bin/loadwise:*)
---

Use the project's Loadwise launcher for every command. Prefer `node_modules/.bin/loadwise` when present, otherwise use `npx loadwise`. Interpret the user's arguments (`$ARGUMENTS`) as follows.

For the default check, pass the supplied directory and scan flags to `loadwise check --json`. Summarize the findings by checker, id, rule and file:line. Keep checks and handoff-only requests read-only.

On every run, review all in-scope findings, including changes already applied. Retrieve `loadwise agent history` for the selected checkers and inspect earlier reports if available. A clean rescan still requires checking the recorded edits against the code and tests. In both check and fix mode, record a status and evidence for each checker and id. Run `loadwise agent verify --outcomes outcomes.json before.json history.json after.json` on the applicable scoped reports and address any missing outcomes. Keep the files in local scratch space. State which prior changes could not be reconstructed.

Use `{"outcomes":[{"checker":"perf","id":"...","status":"verified","evidence":"..."}]}` for the decisions file, replacing the placeholders with actual findings and evidence. Supported statuses are `fixed`, `verified`, `intentional`, `false-positive` and `deferred`. In a detected agent session or an initialized project add `--save` to retain the decisions locally for the next agent unless the user requested no persistence.

For `fix` or a request to address findings, review them before choosing edits.

1. Record existing working changes and start with a read-only JSON scan. For example, `fix performance security` starts with `loadwise check --only perf,sec --json`. Preserve the selected project, configuration, workspaces and changed-line filters. Restrict work to the named files or ids if provided.
2. Evaluate both generated and manual findings against the actual code, callers and tests. Inspect proposed diffs and notes and check their assumptions. Use a generated edit only when you can justify that exact change. Adapt a suggestion or implement a manual fix yourself when warranted. Keep intentional behavior and false positives with a reason. Defer unresolved decisions and continue with independent findings.
3. For each supported edit, apply the confirmed id with the matching `perf`, `rel`, `maint`, `sec` or `a11y` command and `--fix --only <id>`. Use the scoped report's printed fix command when available. Pass the original project settings, converting the unified `--config` option to the checker's `--loadwise-config`. Review-marked changes require individual approval unless already authorized.
4. For changed-line requests, confirm every hunk fits the authorized range. Maintainability accepts `--staged` or `--changed-since` with targeted fixes. For performance and security, use the confirmed ids from the filtered scan without passing those change flags to `--fix`. Leave the Git index untouched.
5. After any fix, including a command the user already ran, inspect every applied hunk against code, callers and tests. Use the before/after report or original diff/output, and rescan. Review applied, skipped, review-marked and manual findings even when none are manual. Correct only attributable changes in scope. Preserve pre-existing work, thresholds and baselines.
6. Run the affected tests or typecheck and repeat the scoped check. If an id shifted, match the rule, location and code. Report verified edits and reasons for remaining findings. If earlier evidence is unavailable, verify the current code and state which prior edits cannot be identified. Request the original diff/output only if needed.

Explicit flags select the matching CLI operation. For `fix --handoff` alone, show the brief and stop. For `fix --yes` or `fix --all`, record existing working changes, run the requested operation with its checker selection, and capture its before/after hunks and per-finding outcomes with `--json` when compatible with the requested output. Verify the actual changes using steps 5 and 6. When manual findings remain in scope, read a fresh `loadwise fix --handoff` for the same checkers. Respect a request limited to generated fixes.
