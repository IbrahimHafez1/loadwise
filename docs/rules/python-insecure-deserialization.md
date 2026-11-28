---
id: python-insecure-deserialization
title: python-insecure-deserialization
description: "pickle or marshal deserialization of untrusted data can execute arbitrary code."
checker: security
group: "Polyglot source checks"
impact: high
fixable: manual
---

## What it flags

`pickle` or `marshal` deserializes data that may be untrusted.

## How to review or fix

Use `json` or a schema-validated format.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "python-insecure-deserialization": "off" }
}
```
