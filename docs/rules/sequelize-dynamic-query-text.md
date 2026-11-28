---
id: sequelize-dynamic-query-text
title: sequelize-dynamic-query-text
description: "Dynamic SQL text reaches Sequelize without parameter binding."
checker: security
group: "Rules"
impact: critical
fixable: manual
---

## What it flags

`sequelize.query` or `literal` receives SQL text built from a runtime value instead of `replacements` or `bind`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "sequelize-dynamic-query-text": "off" }
}
```
