---
id: sql-insert-truncated-at-semicolon
title: sql-insert-truncated-at-semicolon
description: "A SQL dump parser ends INSERT values at a semicolon inside quoted text."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

An INSERT dump parser ends its captured values at the next semicolon, which can occur inside quoted data.

## How to review or fix

Use a parser for the dump dialect and test a quoted semicolon.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "sql-insert-truncated-at-semicolon": "off" }
}
```
