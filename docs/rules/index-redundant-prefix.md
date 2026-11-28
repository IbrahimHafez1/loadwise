---
id: index-redundant-prefix
title: index-redundant-prefix
description: "An index repeats the leading columns of a longer index on the same table, adding write cost for no read benefit."
checker: performance
group: "Schema-aware index checks"
impact: low
fixable: inline
---

## What it flags

An index repeats the leading columns of a longer index on the same table (or duplicates it), adding write and memory cost while serving no read the longer one cannot; drop the shorter one (for Sequelize, remove it from the model too, since `sync({ alter: true })` recreates it). An index inherited from a base entity is reported once, at the base class.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "index-redundant-prefix": "off" }
}
```
