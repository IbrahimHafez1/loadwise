---
id: db-duplicate-index
title: db-duplicate-index
description: "A database index is covered by another index on the same table."
checker: performance
group: "Database inspection (optional)"
impact: low
fixable: inline
related: [db-unindexed-foreign-key, db-seq-scan-heavy-table, db-slow-query-plan, db-missing-index, mongo-collection-scan-observed, db-unused-index]
---

## What it flags

A database index is covered by another index on the same table.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "db-duplicate-index": "off" }
}
```
