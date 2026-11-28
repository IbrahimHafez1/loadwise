---
id: count-then-page-serial
title: count-then-page-serial
description: "A count and a page query with the same filter run one after the other."
checker: performance
group: "Async work and sorting"
impact: low
fixable: inline
---

## What it flags

A `count()` and a page query with the same filter run one after the other (TypeORM query builder or repository, Prisma).

## How to review or fix

Use `getManyAndCount()` or `findAndCount()`, or start both Prisma calls together with `Promise.all` outside an interactive transaction.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "count-then-page-serial": "off" }
}
```
