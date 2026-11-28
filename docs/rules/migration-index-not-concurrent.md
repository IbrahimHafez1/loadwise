---
id: migration-index-not-concurrent
title: migration-index-not-concurrent
description: "A PostgreSQL index is built without CONCURRENTLY, blocking writes to the table."
checker: reliability
group: "Migration safety"
impact: critical
fixable: inline
related: [migration-concurrent-in-transaction]
---

## What it flags

A PostgreSQL index built without `CONCURRENTLY`, or `CONCURRENTLY` inside a transaction that cannot run it.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "migration-index-not-concurrent": "off" }
}
```
