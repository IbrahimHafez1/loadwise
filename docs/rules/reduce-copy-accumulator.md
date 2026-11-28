---
id: reduce-copy-accumulator
title: reduce-copy-accumulator
description: "A reduce callback copies its growing accumulator on every step."
checker: performance
group: "Source checks"
impact: medium
fixable: inline
related: [loop-copy-accumulator, filter-for-existence]
---

## What it flags

Copying a growing result or allocating a filtered array for a boolean test.

## How to review or fix

Consider a private accumulator or a short-circuiting predicate.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "reduce-copy-accumulator": "off" }
}
```
