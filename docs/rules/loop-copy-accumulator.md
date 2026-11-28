---
id: loop-copy-accumulator
title: loop-copy-accumulator
description: "A loop copies its growing result on every iteration."
checker: performance
group: "Source checks"
impact: medium
fixable: inline
related: [reduce-copy-accumulator, filter-for-existence]
---

## What it flags

Copying a growing result or allocating a filtered array for a boolean test.

## How to review or fix

Consider a private accumulator or a short-circuiting predicate.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "loop-copy-accumulator": "off" }
}
```
