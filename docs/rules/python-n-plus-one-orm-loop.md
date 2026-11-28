---
id: python-n-plus-one-orm-loop
title: python-n-plus-one-orm-loop
description: "An ORM query executes inside a Python loop instead of using eager loading or batching."
checker: performance
group: "Polyglot source checks"
impact: high
fixable: manual
---

## What it flags

An ORM query executes inside a Python loop instead of using eager loading or batching.

## Example

An ORM query executes inside a Python `for` loop instead of eager loading or batching.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "python-n-plus-one-orm-loop": "off" }
}
```
