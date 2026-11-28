---
id: prisma-distinct-in-memory
title: prisma-distinct-in-memory
description: "Prisma findMany with distinct reads every matching row and de-duplicates in memory."
checker: performance
group: "ORM and query integrity checks"
impact: medium
fixable: inline
---

## What it flags

`findMany({ distinct })` reads every matching row and de-duplicates in Prisma's query engine, not with SQL `DISTINCT`.

## How to review or fix

Use `groupBy` or a raw `SELECT DISTINCT`. Quiet when the `nativeDistinct` preview feature is enabled.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "prisma-distinct-in-memory": "off" }
}
```
