---
id: prisma-query-in-loop
title: prisma-query-in-loop
description: "A Prisma query runs once per loop iteration."
checker: performance
group: "Source checks"
impact: high
fixable: inline
related: [pg-query-in-loop]
---

## What it flags

Per-item queries.

## How to review or fix

Consider a parameterized set query, relation load or bulk write if ordering and transaction behavior permit it. Prisma can already batch compatible `findUnique` calls.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "prisma-query-in-loop": "off" }
}
```
