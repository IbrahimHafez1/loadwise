---
id: pg-dynamic-query-text
title: pg-dynamic-query-text
description: "Dynamic SQL text reaches the PostgreSQL client without parameter binding."
checker: security
group: "Rules"
impact: medium
fixable: inline
---

## What it flags

Runtime fragments enter SQL text directly.

## How to review or fix

Bind data as parameters and verify how any dynamic identifiers are chosen and quoted. A finding is a code-review prompt.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "pg-dynamic-query-text": "off" }
}
```
