---
id: db-unused-index
title: db-unused-index
description: "A database index has not been scanned since statistics were last reset."
checker: performance
group: "Database inspection (optional)"
impact: low
fixable: inline
related: [db-unindexed-foreign-key, db-seq-scan-heavy-table, db-slow-query-plan, db-missing-index, mongo-collection-scan-observed, db-duplicate-index]
---

## What it flags

A database index has not been scanned since statistics were last reset.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "db-unused-index": "off" }
}
```
