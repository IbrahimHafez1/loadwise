---
id: react-list-missing-key
title: react-list-missing-key
description: "An element or fragment returned from .map() has no key prop, so React cannot track items when the list changes."
checker: reliability
group: "Source rules"
impact: medium
fixable: manual
---

## What it flags

An element or `<>...</>` fragment returned from `.map()` on an array has no `key` prop, so React cannot track items when the list changes. Not reported for `Children.map`, Solid, Vue or Qwik files, or elements with a spread attribute.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "react-list-missing-key": "off" }
}
```
