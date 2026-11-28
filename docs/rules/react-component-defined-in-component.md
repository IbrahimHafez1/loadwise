---
id: react-component-defined-in-component
title: react-component-defined-in-component
description: "A component is declared inside another component and rendered as an element, so it remounts on every render and loses its state and DOM."
checker: performance
group: "Source checks"
impact: medium
fixable: manual
---

## What it flags

A component is declared inside another component and rendered as an element, so it remounts on every render and loses its state and DOM.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "react-component-defined-in-component": "off" }
}
```
