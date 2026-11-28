---
id: duplicate-key-read
title: duplicate-key-read
description: "A trace repeats the same key or row read under one parent span."
checker: performance
group: "Trace checks in other languages and databases"
impact: medium
fixable: manual
---

## What it flags

Two or more reads with the same observable lookup, database target and recorded scalar context under one parent. The comparison accepts application-defined context keys. Supported evidence includes a concrete Redis `GET` key or a narrow SQL equality lookup with its bound parameter. Masked targets, ambiguous context, observed writes, transactions or failed calls suppress the suggestion where identity or freshness is uncertain.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "duplicate-key-read": "off" }
}
```
