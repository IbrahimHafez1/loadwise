---
id: numeric-sort-for-extreme
title: numeric-sort-for-extreme
description: "A numeric sort is used only to read the smallest or largest value."
checker: performance
group: "Async work and sorting"
impact: low
fixable: inline
---

## What it flags

A numeric comparison sort on a private copy, or a nonmutating numeric sort, is used only to retrieve its first or last value. A single-pass extreme can use constant extra space.

## How to review or fix

Preserve empty input, NaN, sparse inputs and signed-zero semantics when applicable.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "numeric-sort-for-extreme": "off" }
}
```
