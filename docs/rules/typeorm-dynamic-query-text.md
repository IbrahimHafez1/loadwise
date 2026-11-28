---
id: typeorm-dynamic-query-text
title: typeorm-dynamic-query-text
description: "A dynamic SQL fragment reaches TypeORM without parameter binding."
checker: security
group: "Rules"
impact: critical
fixable: manual
---

## What it flags

A TypeORM `query` or a query-builder condition, order, group, select or join receives SQL text built from a runtime value.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "typeorm-dynamic-query-text": "off" }
}
```
