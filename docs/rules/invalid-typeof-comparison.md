---
id: invalid-typeof-comparison
title: invalid-typeof-comparison
description: "A typeof result is compared to a string typeof never returns, so the check never matches."
checker: reliability
group: "Source rules"
impact: high
fixable: inline
---

## What it flags

A `typeof` result is compared to a name it never returns, such as `'strnig'`, so the branch never runs. Reported only in JavaScript the compiler does not check; the fix corrects a close misspelling and is marked for review, since the branch starts to run.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "invalid-typeof-comparison": "off" }
}
```
