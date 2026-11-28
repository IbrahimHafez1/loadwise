---
id: command-injection
title: command-injection
description: "Request-controlled input reaches a shell command string."
checker: security
group: "Rules"
impact: critical
fixable: manual
---

## What it flags

Request data reaches a command line a shell parses: `exec`, or `spawn`/`execFile`/execa with `shell` or `sh -c`. An interpolated parameter with no traced caller is contextual.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "command-injection": "off" }
}
```
