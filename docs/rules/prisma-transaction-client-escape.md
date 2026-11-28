---
id: prisma-transaction-client-escape
title: prisma-transaction-client-escape
description: "A Prisma call inside an interactive transaction uses the outer client instead of the transaction client."
checker: reliability
group: "Source rules"
impact: critical
fixable: inline
---

## What it flags

A direct model operation uses the same outer client that opened an interactive transaction.

## How to review or fix

Verify that the operation belongs inside that transaction.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "prisma-transaction-client-escape": "off" }
}
```
