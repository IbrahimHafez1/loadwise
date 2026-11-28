---
id: go-fixed-regexp-in-loop
title: go-fixed-regexp-in-loop
description: "A Go regexp with a fixed pattern is compiled inside a loop."
checker: performance
group: "Polyglot source checks"
impact: medium
fixable: manual
---

## What it flags

A Go regexp with a fixed pattern is compiled inside a loop.

## Example

`regexp.Compile("pattern")` or `regexp.MustCompile("pattern")`

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "go-fixed-regexp-in-loop": "off" }
}
```
