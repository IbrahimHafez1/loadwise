---
id: loop-index-past-length
title: loop-index-past-length
description: "A loop runs its index up to and including length, so the last pass reads past the end."
checker: reliability
group: "Source rules"
impact: high
fixable: inline
---

## What it flags

A `for` loop starts at `0`, runs `i <= items.length` and reads `items[i]`, so the last pass reads past the end. Loops starting at `1` are accepted. The fix changes `<=` to `<` and is marked for review.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "loop-index-past-length": "off" }
}
```
