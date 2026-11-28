---
id: go-string-concat-in-loop
title: go-string-concat-in-loop
description: "String concatenation in a Go loop allocates repeatedly; use strings.Builder."
checker: performance
group: "Polyglot source checks"
impact: medium
fixable: manual
---

## What it flags

String concatenation in a Go loop allocates repeatedly; use strings.Builder.

## Example

Repeated `+=` string concatenation inside a Go `for` loop instead of `strings.Builder`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "go-string-concat-in-loop": "off" }
}
```
