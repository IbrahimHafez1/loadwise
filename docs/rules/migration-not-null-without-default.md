---
id: migration-not-null-without-default
title: migration-not-null-without-default
description: "A NOT NULL column is added without a default, which fails once rows exist."
checker: reliability
group: "Migration safety"
impact: high
fixable: inline
related: [migration-volatile-default]
---

## What it flags

A NOT NULL column added without a default (fails once rows exist), or a volatile default that rewrites the table.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "migration-not-null-without-default": "off" }
}
```
