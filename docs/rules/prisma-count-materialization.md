---
id: prisma-count-materialization
title: prisma-count-materialization
description: "A Prisma query loads rows only to count them."
checker: performance
group: "Source checks"
impact: medium
fixable: inline
related: [pg-count-materialization]
---

## What it flags

Counting an immediately loaded result.

## How to review or fix

Use a database count with equivalent predicates and handle its return type.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "prisma-count-materialization": "off" }
}
```
