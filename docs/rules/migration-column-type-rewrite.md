---
id: migration-column-type-rewrite
title: migration-column-type-rewrite
description: "A migration changes a column type in a way that rewrites the table."
checker: reliability
group: "Migration safety"
impact: critical
fixable: inline
related: [migration-table-rewrite-command]
---

## What it flags

A column type change or command (`VACUUM FULL`, `CLUSTER`, `REINDEX`) that rewrites the table.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "migration-column-type-rewrite": "off" }
}
```
