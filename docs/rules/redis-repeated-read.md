---
id: redis-repeated-read
title: redis-repeated-read
description: "A trace shows repeated sibling Redis GET or HGET calls."
checker: performance
group: "Trace checks in other languages and databases"
impact: medium
fixable: manual
---

## What it flags

Repeated sibling `GET` or `HGET` calls.

## How to review or fix

Consider compatible multi-key reads or bounded pipelining with appropriate cluster slots, ordering and error handling. Recognized pipeline children are excluded.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "redis-repeated-read": "off" }
}
```
