---
id: async-callback-unhandled-rejection
title: async-callback-unhandled-rejection
description: "An async callback given to an event emitter, timer or scheduler has no error handling, so a rejection is unhandled."
checker: reliability
group: "Source rules"
impact: high
fixable: inline
---

## What it flags

An async callback given to `.on`/`.once`, a timer, `process.nextTick` or `cron.schedule` awaits outside a try/catch; nothing handles its promise, so a rejection crashes Node 15+.

## How to review or fix

Fix (review): wrap the body in try/catch that logs the error.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "async-callback-unhandled-rejection": "off" }
}
```
