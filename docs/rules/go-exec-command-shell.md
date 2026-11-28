---
id: go-exec-command-shell
title: go-exec-command-shell
description: "exec.Command invokes a shell, which risks command injection."
checker: security
group: "Polyglot source checks"
impact: high
fixable: manual
---

## What it flags

`exec.Command` invokes a shell. Execute the target binary directly with explicit arguments.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "go-exec-command-shell": "off" }
}
```
