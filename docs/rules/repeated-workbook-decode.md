---
id: repeated-workbook-decode
title: repeated-workbook-decode
description: "A workflow decodes the same input with ExcelJS more than once."
checker: performance
group: "Async work and sorting"
impact: medium
fixable: inline
---

## What it flags

Sibling awaits pass the same input to ExcelJS workbook decoding directly or through same-file private methods or functions.

## How to review or fix

Share a parsed workbook when its readers can safely use the same state.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "repeated-workbook-decode": "off" }
}
```
