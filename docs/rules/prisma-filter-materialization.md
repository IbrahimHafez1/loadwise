---
id: prisma-filter-materialization
title: prisma-filter-materialization
description: "A Prisma query loads an unbounded result that JavaScript then filters by equality."
checker: performance
group: "Source checks"
impact: medium
fixable: inline
related: [pg-filter-materialization]
---

## What it flags

Applying a literal equality filter in JS after loading an unbounded result.

## How to review or fix

Check database collation and null semantics before moving the predicate.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "prisma-filter-materialization": "off" }
}
```
