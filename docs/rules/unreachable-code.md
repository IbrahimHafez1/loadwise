---
id: unreachable-code
title: unreachable-code
description: "Statements follow a return, throw, break or continue in the same block and never run."
checker: reliability
group: "Source rules"
impact: medium
fixable: inline
---

## What it flags

Statements after `return`, `throw`, `break` or `continue` in the same block never run. Hoisted function declarations and type declarations are accepted, and the rule stays silent when `allowUnreachableCode` is `false` because the compiler reports it.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "unreachable-code": "off" }
}
```
