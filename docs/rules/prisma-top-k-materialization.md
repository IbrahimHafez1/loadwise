---
id: prisma-top-k-materialization
title: prisma-top-k-materialization
description: "A Prisma query loads an unbounded result that JavaScript sorts to keep the top rows."
checker: performance
group: "Source checks"
impact: medium
fixable: inline
related: [pg-top-k-materialization]
---

## What it flags

Sorting an unbounded result with a numeric comparator to keep the top rows.

## How to review or fix

Use database ordering and a limit with a stable tie-breaker.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "prisma-top-k-materialization": "off" }
}
```
