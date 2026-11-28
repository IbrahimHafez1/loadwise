---
id: python-unbounded-comprehension
title: python-unbounded-comprehension
description: "A Python list comprehension materializes an unbounded collection in memory."
checker: performance
group: "Polyglot source checks"
impact: medium
fixable: manual
---

## What it flags

A Python list comprehension materializes an unbounded collection in memory.

## Example

A Python list comprehension materializes an unbounded collection in memory.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "python-unbounded-comprehension": "off" }
}
```
