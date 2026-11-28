---
id: knex-raw-dynamic-text
title: knex-raw-dynamic-text
description: "A dynamic SQL fragment reaches Knex without parameter binding."
checker: security
group: "Rules"
impact: critical
fixable: manual
---

## What it flags

A Knex `*Raw` fragment or `knex.raw` receives text built from a runtime value instead of `?`/`??` bindings.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "knex-raw-dynamic-text": "off" }
}
```
