---
id: pg-sequential-scan
title: pg-sequential-scan
description: "A PostgreSQL plan scans many rows for each one it returns."
checker: performance
group: "Executed query plans"
impact: high
fixable: manual
related: [mongo-collection-scan]
---

## What it flags

At least 1,000 examined and at least 100 examined per returned record, treating zero returns as one for this ratio.

## How to review or fix

Review selectivity and available indexes. PostgreSQL totals use the reported per-loop averages.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "pg-sequential-scan": "off" }
}
```
