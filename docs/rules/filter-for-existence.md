---
id: filter-for-existence
title: filter-for-existence
description: "filter(...).length is used only to test whether any element matches."
checker: performance
group: "Source checks"
impact: low
fixable: inline
related: [reduce-copy-accumulator, loop-copy-accumulator]
---

## What it flags

Copying a growing result or allocating a filtered array for a boolean test.

## How to review or fix

Consider a private accumulator or a short-circuiting predicate.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "filter-for-existence": "off" }
}
```
