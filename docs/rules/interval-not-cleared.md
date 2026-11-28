---
id: interval-not-cleared
title: interval-not-cleared
description: "A setInterval handle is discarded or never cleared, so the timer outlives its owner."
checker: reliability
group: "Source rules"
impact: medium
fixable: manual
---

## What it flags

A `setInterval` in a function outside any frontend lifecycle keeps no handle, or its handle never reaches `clearInterval`, so the timer outlives its owner. Startup code, `unref()` timers and React, Vue, Svelte and Angular files (covered by the frontend cleanup rules) are skipped.

## How to review or fix

Decide who owns the timer and clear it when that owner stops.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "interval-not-cleared": "off" }
}
```
