---
id: migration-concurrent-in-transaction
title: migration-concurrent-in-transaction
description: "A CONCURRENTLY index statement runs inside a transaction, where PostgreSQL rejects it."
checker: reliability
group: "Migration safety"
impact: high
fixable: inline
related: [migration-index-not-concurrent]
---

## What it flags

A PostgreSQL index built without `CONCURRENTLY`, or `CONCURRENTLY` inside a transaction that cannot run it.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "migration-concurrent-in-transaction": "off" }
}
```
