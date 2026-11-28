---
id: prisma-relation-count-in-list
title: prisma-relation-count-in-list
description: "A paged Prisma findMany selects a relation _count computed over the whole related table."
checker: performance
group: "ORM and query integrity checks"
impact: medium
fixable: inline
---

## What it flags

A paged `findMany` selects `_count` of a relation, which Prisma computes over the whole related table.

## How to review or fix

Fetch the page, then `groupBy` for the page ids and merge the counts.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "prisma-relation-count-in-list": "off" }
}
```
