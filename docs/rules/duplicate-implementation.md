---
id: duplicate-implementation
title: duplicate-implementation
description: "Substantial functions share the same implementation."
checker: maintainability
group: "What gets checked"
impact: medium
fixable: inline
---

## What it flags

Substantial functions share a verified implementation. The report groups matching sites so a reviewer can compare their contracts before introducing a shared abstraction. JS/TS compares syntax while preserving identifiers, literals and operations. Python, Go, Java, C# and Rust compare exact body text of named functions selected by the parser. This deliberately misses reformatted or renamed copies.

## Inline fix

Keeps one top-level function and makes each other copy delegate to it, adding an import where needed. Applied only when every name the copies use resolves to the same binding.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "duplicate-implementation": "off" }
}
```
