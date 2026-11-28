---
id: db-seq-scan-heavy-table
title: db-seq-scan-heavy-table
description: "A large table is read by many sequential scans on the live database."
checker: performance
group: "Database inspection (optional)"
impact: high
fixable: manual
related: [db-unindexed-foreign-key, db-slow-query-plan, db-missing-index, mongo-collection-scan-observed, db-unused-index, db-duplicate-index]
---

## What it flags

A large table is read by many sequential scans on the live database.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "db-seq-scan-heavy-table": "off" }
}
```
