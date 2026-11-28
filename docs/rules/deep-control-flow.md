---
id: deep-control-flow
title: deep-control-flow
description: "Control structures are nested four levels deep."
checker: maintainability
group: "What gets checked"
impact: low
fixable: inline
---

## What it flags

Four nested control structures. JS/TS reports the deepest site in each function. The other parsers report threshold crossings in supported conditional and loop bodies. Independent function scopes start fresh.

## Inline fix

Lifts the deepest branch one level with a guard clause, a merged nested `if`, or by dropping an `else` after a branch that exits.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "deep-control-flow": "off" }
}
```
