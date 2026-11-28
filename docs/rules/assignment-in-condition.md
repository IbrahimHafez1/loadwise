---
id: assignment-in-condition
title: assignment-in-condition
description: "A condition assigns with = where a comparison was probably meant."
checker: reliability
group: "Source rules"
impact: high
fixable: inline
---

## What it flags

A condition uses `=` where `===` was probably meant, so it overwrites the variable and tests the assigned value. Doubled parentheses `if ((match = re.exec(text)))`, ternary conditions, calls and loops that read and assign are accepted.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "assignment-in-condition": "off" }
}
```
