---
id: guard-query-per-request
title: guard-query-per-request
description: "A guard or per-request hook runs a database query before every handler."
checker: performance
group: "ORM and query integrity checks"
impact: medium
fixable: inline
---

## What it flags

A guard or similar per-request hook runs a database query before every handler.

## How to review or fix

Cache the lookup with a short TTL and explicit invalidation, or carry the claims in the token.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "guard-query-per-request": "off" }
}
```
