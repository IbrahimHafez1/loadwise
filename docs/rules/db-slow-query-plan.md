---
id: db-slow-query-plan
title: db-slow-query-plan
description: "One of the slowest statements reads a table with a full table scan."
checker: performance
group: "Database inspection (optional)"
impact: high
fixable: inline
related: [db-unindexed-foreign-key, db-seq-scan-heavy-table, db-missing-index, mongo-collection-scan-observed, db-unused-index, db-duplicate-index]
---

## What it flags

One of the slowest statements reads a table with a full table scan.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "db-slow-query-plan": "off" }
}
```
