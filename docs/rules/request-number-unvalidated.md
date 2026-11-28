---
id: request-number-unvalidated
title: request-number-unvalidated
description: "A number parsed from request input reaches a query or calculation with no NaN or range check."
checker: reliability
group: "Source rules"
impact: medium
fixable: inline
---

## What it flags

`Number`, `parseInt`, `parseFloat` or unary `+` of raw request input reaches a query, `slice`/`limit`/`skip`/`take`, an index or kept arithmetic with no NaN or range check. Schema-validated values, Nest DTOs and pipes are skipped.

## How to review or fix

Fix (review): a 400 guard after the declaration.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "request-number-unvalidated": "off" }
}
```
