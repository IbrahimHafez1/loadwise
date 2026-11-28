---
id: csharp-ef-from-sql-raw
title: csharp-ef-from-sql-raw
description: "FromSqlRaw or ExecuteSqlRaw receives a concatenated or interpolated string, risking SQL injection."
checker: security
group: "Polyglot source checks"
impact: high
fixable: manual
---

## What it flags

`FromSqlRaw` or `ExecuteSqlRaw` receives a concatenated or interpolated string.

## How to review or fix

Use `FromSqlInterpolated` or bind parameters.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "csharp-ef-from-sql-raw": "off" }
}
```
