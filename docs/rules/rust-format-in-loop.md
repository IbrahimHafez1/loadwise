---
id: rust-format-in-loop
title: rust-format-in-loop
description: "Calling format! inside a Rust loop allocates a new String on every iteration."
checker: performance
group: "Polyglot source checks"
impact: low
fixable: manual
---

## What it flags

Calling format! inside a Rust loop allocates a new String on every iteration.

## Example

Calling `format!` inside a Rust loop allocates a new `String` on every iteration.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "rust-format-in-loop": "off" }
}
```
