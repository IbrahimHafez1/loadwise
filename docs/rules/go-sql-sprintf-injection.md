---
id: go-sql-sprintf-injection
title: go-sql-sprintf-injection
description: "SQL text formatted with fmt.Sprintf risks SQL injection."
checker: security
group: "Polyglot source checks"
impact: high
fixable: manual
---

## What it flags

SQL text is formatted with `fmt.Sprintf`.

## How to review or fix

Use parameterized queries with placeholders.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "go-sql-sprintf-injection": "off" }
}
```
