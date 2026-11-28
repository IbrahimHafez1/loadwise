---
id: migration-volatile-default
title: migration-volatile-default
description: "A column is added with a volatile default, which rewrites the table."
checker: reliability
group: "Migration safety"
impact: high
fixable: inline
related: [migration-not-null-without-default]
---

## What it flags

A NOT NULL column added without a default (fails once rows exist), or a volatile default that rewrites the table.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "migration-volatile-default": "off" }
}
```
