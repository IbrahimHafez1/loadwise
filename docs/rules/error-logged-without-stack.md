---
id: error-logged-without-stack
title: error-logged-without-stack
description: "A catch block logs only error.message and carries on, so the stack trace is lost."
checker: reliability
group: "Source rules"
impact: low
fixable: manual
---

## What it flags

A `catch (err)` block that reads `err` only as `err.message` inside a `console` or logger `error`/`fatal` call, and neither rethrows nor exits, loses the stack and any `cause`. Log the error object itself. A block that also reads `err.code`, `err.stack` or passes `err` on is skipped.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "error-logged-without-stack": "off" }
}
```
