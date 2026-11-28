---
id: pg-filter-materialization
title: pg-filter-materialization
description: "A pg query loads an unbounded result that JavaScript then filters by equality."
checker: performance
group: "Source checks"
impact: medium
fixable: manual
related: [prisma-filter-materialization]
---

## What it flags

Applying a literal equality filter in JS after loading an unbounded result.

## How to review or fix

Check database collation and null semantics before moving the predicate.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "pg-filter-materialization": "off" }
}
```
