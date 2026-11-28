---
id: query-runner-not-released
title: query-runner-not-released
description: "A TypeORM QueryRunner is not released in a finally block, so an error leaks its pooled connection."
checker: reliability
group: "Source rules"
impact: critical
fixable: inline
---

## What it flags

A TypeORM `createQueryRunner()` is not released in `finally`, so an early return or failed transaction keeps the pooled connection.

## How to review or fix

Confirm no caller releases it, then call `release()` in `finally`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "query-runner-not-released": "off" }
}
```
