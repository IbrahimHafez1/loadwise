---
id: csharp-fixed-regex-in-loop
title: csharp-fixed-regex-in-loop
description: "A C# Regex with a fixed pattern is constructed inside a loop."
checker: performance
group: "Polyglot source checks"
impact: medium
fixable: manual
---

## What it flags

A C# Regex with a fixed pattern is constructed inside a loop.

## Example

`new Regex("pattern")`

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "csharp-fixed-regex-in-loop": "off" }
}
```
