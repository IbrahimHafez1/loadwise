---
id: return-newline
title: return-newline
description: "A line break after return ends the statement before the apparent return value."
checker: reliability
group: "Source rules"
impact: high
fixable: inline
---

## What it flags

A line break immediately after `return` ends the statement before an apparent object or parenthesized return value.

## How to review or fix

Start the expression on the same line as `return`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "return-newline": "off" }
}
```
