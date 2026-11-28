---
id: migration-table-rewrite-command
title: migration-table-rewrite-command
description: "A migration runs VACUUM FULL, CLUSTER or REINDEX, which rewrites or locks the table."
checker: reliability
group: "Migration safety"
impact: critical
fixable: inline
related: [migration-column-type-rewrite]
---

## What it flags

A column type change or command (`VACUUM FULL`, `CLUSTER`, `REINDEX`) that rewrites the table.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "migration-table-rewrite-command": "off" }
}
```
