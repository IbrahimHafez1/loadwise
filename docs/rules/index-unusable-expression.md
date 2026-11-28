---
id: index-unusable-expression
title: index-unusable-expression
description: "A function or expression on an indexed column keeps the index from being used."
checker: performance
group: "Schema-aware index checks"
impact: high
fixable: inline
---

## What it flags

A function or expression on an indexed column prevents the index from being used.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "index-unusable-expression": "off" }
}
```
