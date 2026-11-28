---
id: pg-count-materialization
title: pg-count-materialization
description: "A pg query loads rows only to count them."
checker: performance
group: "Source checks"
impact: medium
fixable: inline
related: [prisma-count-materialization]
---

## What it flags

Counting an immediately loaded result.

## How to review or fix

Use a database count with equivalent predicates and handle its return type.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "pg-count-materialization": "off" }
}
```
