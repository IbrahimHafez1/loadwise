---
id: typeorm-transaction-client-escape
title: typeorm-transaction-client-escape
description: "A write inside a TypeORM transaction goes through a repository not bound to it."
checker: reliability
group: "Source rules"
impact: critical
fixable: inline
---

## What it flags

An awaited write inside a TypeORM transaction goes through a repository or manager that is not bound to it, so it autocommits on another pooled connection, is not rolled back with the transaction and can block on its locks.

## How to review or fix

Use the transaction's manager (`manager.getRepository(Entity)`).

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "typeorm-transaction-client-escape": "off" }
}
```
