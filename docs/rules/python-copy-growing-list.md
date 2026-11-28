---
id: python-copy-growing-list
title: python-copy-growing-list
description: "A Python loop rebuilds a growing list with items = items + [value]."
checker: performance
group: "Polyglot source checks"
impact: medium
fixable: manual
---

## What it flags

A Python loop rebuilds a growing list with items = items + [value].

## Example

A list initialized to `[]` is repeatedly assigned `items = items + [value]` in a simple loop.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "python-copy-growing-list": "off" }
}
```
