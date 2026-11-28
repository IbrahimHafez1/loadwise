---
id: pg-top-k-materialization
title: pg-top-k-materialization
description: "A pg query loads an unbounded result that JavaScript sorts to keep the top rows."
checker: performance
group: "Source checks"
impact: medium
fixable: manual
related: [prisma-top-k-materialization]
---

## What it flags

Sorting an unbounded result with a numeric comparator to keep the top rows.

## How to review or fix

Use database ordering and a limit with a stable tie-breaker.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "pg-top-k-materialization": "off" }
}
```
