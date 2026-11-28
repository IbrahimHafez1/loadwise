---
id: json-roundtrip-clone
title: json-roundtrip-clone
description: "A value is deep-cloned with JSON.parse(JSON.stringify(...)) on a request path."
checker: performance
group: "Source checks"
impact: low
fixable: inline
---

## What it flags

A value is deep-copied with `JSON.parse(JSON.stringify(...))` in a request handler or loop.

## How to review or fix

Use `structuredClone`, or copy only the fields you change.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "json-roundtrip-clone": "off" }
}
```
