---
id: react-index-as-key
title: react-index-as-key
description: "A list item uses the map index as its React key, which breaks reconciliation when items are inserted or reordered."
checker: performance
group: "Source checks"
impact: low
fixable: manual
---

## What it flags

A list item uses the map index as its React key, which breaks reconciliation when items are inserted or reordered.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "react-index-as-key": "off" }
}
```
