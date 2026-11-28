---
id: rebuild-lookup-in-loop
title: rebuild-lookup-in-loop
description: "A Set or Map is rebuilt from the same data on every loop iteration."
checker: performance
group: "Source checks"
impact: high
fixable: inline
related: [array-repeated-membership, array-repeated-find]
---

## What it flags

Repeated linear lookups or rebuilt indexes.

## How to review or fix

Reuse a Set or Map if inputs are stable and enough lookups justify construction. Preserve first-match semantics with duplicate keys.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "rebuild-lookup-in-loop": "off" }
}
```
