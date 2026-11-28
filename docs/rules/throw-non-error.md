---
id: throw-non-error
title: throw-non-error
description: "A string, number or object literal is thrown instead of an Error, so there is no stack trace."
checker: reliability
group: "Source rules"
impact: medium
fixable: manual
---

## What it flags

`throw` of a string, template, number, object literal, array, boolean or `null` gives no stack trace and fails `instanceof Error` checks in callers. Throw an `Error` or a subclass. Thrown variables and call results are not judged.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "throw-non-error": "off" }
}
```
