---
id: db-missing-index
title: db-missing-index
description: "A query plan scans a table that a suggested index would let it seek."
checker: performance
group: "Database inspection (optional)"
impact: high
fixable: inline
related: [db-unindexed-foreign-key, db-seq-scan-heavy-table, db-slow-query-plan, mongo-collection-scan-observed, db-unused-index, db-duplicate-index]
---

## What it flags

A query plan scans a table that a suggested index would let it seek.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "db-missing-index": "off" }
}
```
