---
id: migration-mysql-table-copy
title: migration-mysql-table-copy
description: "A MySQL ALTER copies the whole table."
checker: reliability
group: "Migration safety"
impact: critical
fixable: inline
related: [migration-mysql-lock-unspecified]
---

## What it flags

MySQL changes that copy the table or leave the lock level unspecified.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "migration-mysql-table-copy": "off" }
}
```
