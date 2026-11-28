---
id: array-repeated-find
title: array-repeated-find
description: "An array is searched with find or findIndex repeatedly where a Map lookup would do."
checker: performance
group: "Source checks"
impact: medium
fixable: inline
related: [rebuild-lookup-in-loop, array-repeated-membership]
---

## What it flags

Repeated linear lookups or rebuilt indexes.

## How to review or fix

Reuse a Set or Map if inputs are stable and enough lookups justify construction. Preserve first-match semantics with duplicate keys.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "array-repeated-find": "off" }
}
```
