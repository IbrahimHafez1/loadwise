---
id: java-sql-string-concat
title: java-sql-string-concat
description: "A SQL query built by string concatenation risks SQL injection."
checker: security
group: "Polyglot source checks"
impact: high
fixable: manual
---

## What it flags

A SQL query is built by string concatenation.

## How to review or fix

Use `PreparedStatement` with bound parameters.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "java-sql-string-concat": "off" }
}
```
