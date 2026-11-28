---
id: java-fixed-regex-in-loop
title: java-fixed-regex-in-loop
description: "A Java Pattern with a fixed pattern is compiled inside a loop."
checker: performance
group: "Polyglot source checks"
impact: medium
fixable: manual
---

## What it flags

A Java Pattern with a fixed pattern is compiled inside a loop.

## Example

`Pattern.compile("pattern")`

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "java-fixed-regex-in-loop": "off" }
}
```
