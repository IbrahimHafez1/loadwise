---
id: index-missing-foreign-key
title: index-missing-foreign-key
description: "A foreign key column in the schema has no index."
checker: performance
group: "Schema-aware index checks"
impact: high
fixable: inline
---

## What it flags

A foreign key column has no index.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "index-missing-foreign-key": "off" }
}
```
