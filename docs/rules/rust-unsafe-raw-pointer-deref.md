---
id: rust-unsafe-raw-pointer-deref
title: rust-unsafe-raw-pointer-deref
description: "A raw pointer dereference in an unsafe block bypasses Rust memory safety guarantees."
checker: security
group: "Polyglot source checks"
impact: medium
fixable: manual
---

## What it flags

A raw pointer is dereferenced in an `unsafe` block.

## How to review or fix

Verify pointer validity and alignment or use safe abstractions.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "rust-unsafe-raw-pointer-deref": "off" }
}
```
