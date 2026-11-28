---
id: nan-comparison
title: nan-comparison
description: "A value is compared to NaN with an equality operator, which is never true."
checker: reliability
group: "Source rules"
impact: high
fixable: inline
---

## What it flags

A value is compared to `NaN` with `==` or `===`, which is never true. Reported only in JavaScript the compiler does not check, since TypeScript reports it otherwise. The fix uses `Number.isNaN` and is marked for review, since the branch starts to run.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "nan-comparison": "off" }
}
```
