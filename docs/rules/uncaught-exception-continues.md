---
id: uncaught-exception-continues
title: uncaught-exception-continues
description: "An uncaughtException handler neither exits nor rethrows, so the process keeps running in an undefined state."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

A `process.on('uncaughtException', handler)` whose handler neither exits, rethrows, sets `process.exitCode` nor starts a shutdown, so the process keeps running in an unknown state. Log, shut down, then exit non-zero.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "uncaught-exception-continues": "off" }
}
```
