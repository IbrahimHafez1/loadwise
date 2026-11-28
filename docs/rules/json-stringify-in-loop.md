---
id: json-stringify-in-loop
title: json-stringify-in-loop
description: "JSON.stringify runs inside a loop instead of serializing once or streaming."
checker: performance
group: "Source checks"
impact: medium
fixable: manual
---

## What it flags

`JSON.stringify()` is called inside a `for`, `while`, `do`, `.forEach`, `.map`, or `.reduce` loop.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "json-stringify-in-loop": "off" }
}
```
