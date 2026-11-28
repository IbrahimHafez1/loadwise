---
id: typeorm-load-then-save
title: typeorm-load-then-save
description: "A TypeORM entity is loaded only to change a few fields and save it back."
checker: performance
group: "ORM and query integrity checks"
impact: high
fixable: inline
---

## What it flags

A repository entity is loaded only to change a few fields and then `save()`d, costing a SELECT, an UPDATE and a transaction.

## How to review or fix

Use `update()` or `increment()`; entity listeners and subscribers for update will not run.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "typeorm-load-then-save": "off" }
}
```
