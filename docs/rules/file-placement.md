---
id: file-placement
title: file-placement
description: "A file with a configured suffix sits outside its allowed folders."
checker: maintainability
group: "What gets checked"
impact: low
fixable: manual
related: [folder-boundary]
---

## What it flags

An import crosses a boundary declared by the team, or a filename suffix occurs outside its allowed folders. Both policies are opt-in.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "file-placement": "off" }
}
```
