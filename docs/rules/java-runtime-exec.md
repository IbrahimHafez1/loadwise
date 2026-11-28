---
id: java-runtime-exec
title: java-runtime-exec
description: "Runtime.getRuntime().exec runs an OS command and risks command injection with untrusted arguments."
checker: security
group: "Polyglot source checks"
impact: medium
fixable: manual
---

## What it flags

`Runtime.getRuntime().exec` runs an OS command.

## How to review or fix

Use `ProcessBuilder` with an explicit argument array.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "java-runtime-exec": "off" }
}
```
