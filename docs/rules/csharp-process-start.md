---
id: csharp-process-start
title: csharp-process-start
description: "Process.Start launches an external process and risks command injection with untrusted arguments."
checker: security
group: "Polyglot source checks"
impact: medium
fixable: manual
---

## What it flags

`Process.Start` launches an external process.

## How to review or fix

Validate inputs and use `ProcessStartInfo` with `ArgumentList`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "csharp-process-start": "off" }
}
```
