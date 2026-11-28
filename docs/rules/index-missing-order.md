---
id: index-missing-order
title: index-missing-order
description: "A query orders by columns that no index serves in that order."
checker: performance
group: "Schema-aware index checks"
impact: medium
fixable: inline
---

## What it flags

A query orders by columns no index can serve in that order.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "index-missing-order": "off" }
}
```
