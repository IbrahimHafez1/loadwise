---
id: migration-breaking-drop
title: migration-breaking-drop
description: "A migration drops a column or table that running code may still use."
checker: reliability
group: "Migration safety"
impact: critical
fixable: inline
related: [migration-breaking-rename]
---

## What it flags

Dropping or renaming a column or table that running application code may still use.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "migration-breaking-drop": "off" }
}
```
