---
id: prisma-first-materialization
title: prisma-first-materialization
description: "A Prisma query loads an unbounded result to read only its first row."
checker: performance
group: "Source checks"
impact: medium
fixable: inline
related: [pg-first-materialization]
---

## What it flags

Reading only index zero from an unbounded result.

## How to review or fix

Preserve ordering and empty-result behavior when limiting the query.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "prisma-first-materialization": "off" }
}
```
