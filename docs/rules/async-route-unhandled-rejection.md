---
id: async-route-unhandled-rejection
title: async-route-unhandled-rejection
description: "An Express 4 async route handler has no error handling, so a rejection never reaches the error middleware."
checker: reliability
group: "Source rules"
impact: high
fixable: inline
---

## What it flags

An async Express 4 route handler awaits outside a try/catch and takes no `next`, so a rejection skips the error middleware and the request hangs. Silent on Express 5 and with express-async-errors, express-async-handler or a wrapping call; an unknown Express version is contextual.

## How to review or fix

Fix (review): wrap the body in try/catch and pass the error to `next`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "async-route-unhandled-rejection": "off" }
}
```
