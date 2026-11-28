---
id: vue-watch-missing-cleanup
title: vue-watch-missing-cleanup
description: "onMounted registers a global listener, timer or observer with no unmount cleanup."
checker: performance
group: "Source checks"
impact: medium
fixable: manual
---

## What it flags

onMounted registers a global listener, timer or observer with no unmount cleanup.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "vue-watch-missing-cleanup": "off" }
}
```
