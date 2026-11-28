---
id: index-missing-filter
title: index-missing-filter
description: "A query filters on a column that no index leads with."
checker: performance
group: "Schema-aware index checks"
impact: high
fixable: inline
---

## What it flags

A query filters on a column that no index leads with.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "index-missing-filter": "off" }
}
```
