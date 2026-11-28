---
id: migration-mysql-lock-unspecified
title: migration-mysql-lock-unspecified
description: "A MySQL ALTER does not state its LOCK level."
checker: reliability
group: "Migration safety"
impact: high
fixable: inline
related: [migration-mysql-table-copy]
---

## What it flags

MySQL changes that copy the table or leave the lock level unspecified.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "migration-mysql-lock-unspecified": "off" }
}
```
