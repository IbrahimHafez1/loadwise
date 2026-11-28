---
id: array-repeated-membership
title: array-repeated-membership
description: "An array is tested with includes or indexOf repeatedly where a Set would do."
checker: performance
group: "Source checks"
impact: medium
fixable: inline
related: [rebuild-lookup-in-loop, array-repeated-find]
---

## What it flags

Repeated linear lookups or rebuilt indexes.

## How to review or fix

Reuse a Set or Map if inputs are stable and enough lookups justify construction. Preserve first-match semantics with duplicate keys.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "array-repeated-membership": "off" }
}
```
