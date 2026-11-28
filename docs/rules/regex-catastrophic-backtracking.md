---
id: regex-catastrophic-backtracking
title: regex-catastrophic-backtracking
description: "A regular expression that can backtrack exponentially or in polynomial time runs on request input."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

A fixed regular expression with nested or overlapping repetition (such as `(a+)+` or `(a|aa)+`), or overlapping repeats in sequence (such as `\s+.*\s+$`), runs on request input and can backtrack exponentially or in polynomial time, blocking the event loop. Rewrite it so each part matches text one way. Cutting the input to a fixed length first, such as `slice(0, 254)`, clears only the polynomial cases.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "regex-catastrophic-backtracking": "off" }
}
```
