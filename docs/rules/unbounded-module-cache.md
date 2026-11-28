---
id: unbounded-module-cache
title: unbounded-module-cache
description: "A long-lived cache accepts dynamic keys without an apparent bound or eviction."
checker: performance
group: "Source checks"
impact: medium
fixable: manual
---

## What it flags

A module-level or singleton-service `Map`, `Set` or object is filled by dynamic key inside functions and never deleted from, cleared or size-checked. The key space may still be small.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "unbounded-module-cache": "off" }
}
```
