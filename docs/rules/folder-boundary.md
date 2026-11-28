---
id: folder-boundary
title: folder-boundary
description: "An import crosses a folder boundary the team declared."
checker: maintainability
group: "What gets checked"
impact: medium
fixable: manual
related: [file-placement]
---

## What it flags

An import crosses a boundary declared by the team, or a filename suffix occurs outside its allowed folders. Both policies are opt-in.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "folder-boundary": "off" }
}
```
