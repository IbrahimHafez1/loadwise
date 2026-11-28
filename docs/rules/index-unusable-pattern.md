---
id: index-unusable-pattern
title: index-unusable-pattern
description: "A predicate such as a leading-wildcard LIKE cannot use an ordinary index."
checker: performance
group: "Schema-aware index checks"
impact: high
fixable: inline
---

## What it flags

A predicate such as a leading-wildcard `LIKE` cannot use an ordinary index.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "index-unusable-pattern": "off" }
}
```
