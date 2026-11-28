---
id: java-string-concat-in-loop
title: java-string-concat-in-loop
description: "String concatenation in a Java loop allocates repeatedly; use StringBuilder."
checker: performance
group: "Polyglot source checks"
impact: medium
fixable: manual
---

## What it flags

String concatenation in a Java loop allocates repeatedly; use StringBuilder.

## Example

Repeated `+=` string concatenation inside a Java loop instead of `StringBuilder`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "java-string-concat-in-loop": "off" }
}
```
