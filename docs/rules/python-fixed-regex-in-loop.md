---
id: python-fixed-regex-in-loop
title: python-fixed-regex-in-loop
description: "A Python loop compiles a fixed pattern with re.compile on every iteration."
checker: performance
group: "Polyglot source checks"
impact: low
fixable: manual
---

## What it flags

A Python loop compiles a fixed pattern with re.compile on every iteration.

## Example

`re.compile("pattern")` with a string literal, in a module that imports `re`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "python-fixed-regex-in-loop": "off" }
}
```
