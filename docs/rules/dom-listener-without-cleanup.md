---
id: dom-listener-without-cleanup
title: dom-listener-without-cleanup
description: "A window or document listener uses an inline function with no AbortSignal or once, so it can never be removed."
checker: performance
group: "Source checks"
impact: low
fixable: manual
---

## What it flags

A window or document listener uses an inline function with no AbortSignal or once, so it can never be removed.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "dom-listener-without-cleanup": "off" }
}
```
