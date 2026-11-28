---
id: large-module
title: large-module
description: "A file has more than 600 lines of code."
checker: maintainability
group: "What gets checked"
impact: low
fixable: inline
---

## What it flags

A JS/TS file has more than 600 lines of code, not counting comments and blank lines. Generated and test files are skipped.

## How to review or fix

Override with `limits.largeModuleLines`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "large-module": "off" }
}
```
