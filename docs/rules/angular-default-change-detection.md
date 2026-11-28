---
id: angular-default-change-detection
title: angular-default-change-detection
description: "An Angular component uses default change detection instead of OnPush, so its subtree is re-checked on every event."
checker: performance
group: "Source checks"
impact: low
fixable: inline
---

## What it flags

An Angular component uses default change detection instead of OnPush, so its subtree is re-checked on every event.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "angular-default-change-detection": "off" }
}
```
