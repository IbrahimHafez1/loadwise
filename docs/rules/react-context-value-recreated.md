---
id: react-context-value-recreated
title: react-context-value-recreated
description: "An inline object or array literal in Context.Provider value creates a new reference on every render."
checker: performance
group: "Source checks"
impact: low
fixable: manual
---

## What it flags

An inline object or array literal in `<*.Provider value={...}>` creates a new reference on every render without `useMemo`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "react-context-value-recreated": "off" }
}
```
