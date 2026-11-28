---
id: prisma-read-modify-write
title: prisma-read-modify-write
description: "A Prisma read feeds a numeric update of the same row, losing concurrent updates."
checker: reliability
group: "Source rules"
impact: critical
fixable: inline
---

## What it flags

A direct read of one row feeds a numeric update of the same field and key.

## How to review or fix

Review atomic arithmetic, an optimistic version check or serializable execution with retries.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "prisma-read-modify-write": "off" }
}
```
