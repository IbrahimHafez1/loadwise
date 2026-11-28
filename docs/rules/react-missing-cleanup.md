---
id: react-missing-cleanup
title: react-missing-cleanup
description: "An effect starts a global listener, interval, socket or endless subscription and returns no cleanup, so it leaks on every remount."
checker: performance
group: "Source checks"
impact: medium
fixable: manual
---

## What it flags

An effect starts a global listener, interval, socket or endless subscription and returns no cleanup, so it leaks on every remount.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "react-missing-cleanup": "off" }
}
```
