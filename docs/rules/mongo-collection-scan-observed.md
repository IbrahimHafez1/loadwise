---
id: mongo-collection-scan-observed
title: mongo-collection-scan-observed
description: "Profiled MongoDB operations scanned a whole collection."
checker: performance
group: "Database inspection (optional)"
impact: high
fixable: manual
related: [db-unindexed-foreign-key, db-seq-scan-heavy-table, db-slow-query-plan, db-missing-index, db-unused-index, db-duplicate-index]
---

## What it flags

Profiled MongoDB operations scanned a whole collection.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "mongo-collection-scan-observed": "off" }
}
```
