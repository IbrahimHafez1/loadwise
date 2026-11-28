---
id: mysql-dynamic-query-text
title: mysql-dynamic-query-text
description: "Dynamic SQL text reaches a MySQL client without parameter binding."
checker: security
group: "Rules"
impact: critical
fixable: manual
---

## What it flags

A `mysql`/`mysql2` `query` or `execute` receives SQL text built from a runtime value instead of `?` placeholders.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "mysql-dynamic-query-text": "off" }
}
```
