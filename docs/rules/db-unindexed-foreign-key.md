---
id: db-unindexed-foreign-key
title: db-unindexed-foreign-key
description: "A foreign key on the live database has no index that leads with its columns."
checker: performance
group: "Database inspection (optional)"
impact: high
fixable: inline
related: [db-seq-scan-heavy-table, db-slow-query-plan, db-missing-index, mongo-collection-scan-observed, db-unused-index, db-duplicate-index]
---

## What it flags

A foreign key on the live database has no index that leads with its columns.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "db-unindexed-foreign-key": "off" }
}
```
