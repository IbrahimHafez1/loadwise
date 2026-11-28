---
id: python-subprocess-shell-true
title: python-subprocess-shell-true
description: "subprocess with shell=True or os.system passes input through a shell, risking command injection."
checker: security
group: "Polyglot source checks"
impact: high
fixable: manual
---

## What it flags

`subprocess` with `shell=True` or `os.system` passes input through a shell.

## How to review or fix

Pass an argument list with `shell=False`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "python-subprocess-shell-true": "off" }
}
```
