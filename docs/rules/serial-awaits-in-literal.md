---
id: serial-awaits-in-literal
title: serial-awaits-in-literal
description: "An array or object literal awaits two or more independent values one after another."
checker: performance
group: "Source checks"
impact: medium
fixable: inline
---

## What it flags

An array or object awaits multiple values in order. The `Promise.all` edit requires review for shared resources, concurrency limits and failure ordering.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "serial-awaits-in-literal": "off" }
}
```
