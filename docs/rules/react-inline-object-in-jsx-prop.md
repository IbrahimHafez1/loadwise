---
id: react-inline-object-in-jsx-prop
title: react-inline-object-in-jsx-prop
description: "An inline object literal is passed to a memo() component, creating a new reference each render and defeating the memo."
checker: performance
group: "Source checks"
impact: low
fixable: manual
---

## What it flags

An inline object literal is passed to a memo() component, creating a new reference each render and defeating the memo.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "react-inline-object-in-jsx-prop": "off" }
}
```
