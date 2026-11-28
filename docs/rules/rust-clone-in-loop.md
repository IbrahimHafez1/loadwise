---
id: rust-clone-in-loop
title: rust-clone-in-loop
description: "Cloning values inside a Rust loop adds avoidable heap allocations."
checker: performance
group: "Polyglot source checks"
impact: low
fixable: manual
---

## What it flags

Cloning values inside a Rust loop adds avoidable heap allocations.

## Example

Calling `.clone()` inside a Rust loop adds avoidable heap allocations.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "rust-clone-in-loop": "off" }
}
```
