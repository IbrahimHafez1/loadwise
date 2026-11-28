---
id: rust-command-shell
title: rust-command-shell
description: "Command::new(\"sh\") or Command::new(\"bash\") spawns a shell and risks command injection."
checker: security
group: "Polyglot source checks"
impact: high
fixable: manual
---

## What it flags

`Command::new("sh")` or `Command::new("bash")` spawns a shell. Invoke the executable directly with `.arg()`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "rust-command-shell": "off" }
}
```
