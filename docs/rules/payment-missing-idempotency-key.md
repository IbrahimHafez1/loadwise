---
id: payment-missing-idempotency-key
title: payment-missing-idempotency-key
description: "A Stripe call that moves money has no idempotency key, so a retry can charge or pay out twice."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

A Stripe call that moves money has no idempotency key, so a retry can charge or pay out twice.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "payment-missing-idempotency-key": "off" }
}
```
