---
id: webhook-missing-idempotency-check
title: webhook-missing-idempotency-check
description: "A webhook route inserts rows without first checking whether the event was already processed."
checker: reliability
group: "Source rules"
impact: medium
fixable: manual
---

## What it flags

A webhook route inserts rows without first checking whether the event was already processed.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "webhook-missing-idempotency-check": "off" }
}
```
