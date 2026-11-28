---
id: frontend-barrel-heavy-import
title: frontend-barrel-heavy-import
description: "A client module imports the whole of lodash or moment instead of subpaths or a lighter library."
checker: performance
group: "Source checks"
impact: low
fixable: manual
---

## What it flags

A client module imports the whole of lodash or moment instead of subpaths or a lighter library.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "frontend-barrel-heavy-import": "off" }
}
```
