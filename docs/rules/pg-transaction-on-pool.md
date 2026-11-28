---
id: pg-transaction-on-pool
title: pg-transaction-on-pool
description: "A transaction statement is sent to a pool, so its statements can run on different connections."
checker: reliability
group: "Source rules"
impact: critical
fixable: inline
---

## What it flags

A standalone transaction-control statement is sent to a typed pool.

## How to review or fix

Use the same checked-out client for the whole transaction and release it in `finally`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "pg-transaction-on-pool": "off" }
}
```
