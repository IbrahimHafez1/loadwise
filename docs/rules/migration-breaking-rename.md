---
id: migration-breaking-rename
title: migration-breaking-rename
description: "A migration renames a column or table that running code may still use."
checker: reliability
group: "Migration safety"
impact: high
fixable: inline
related: [migration-breaking-drop]
---

## What it flags

Dropping or renaming a column or table that running application code may still use.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "migration-breaking-rename": "off" }
}
```
