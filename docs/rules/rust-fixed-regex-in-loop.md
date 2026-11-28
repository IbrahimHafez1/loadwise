---
id: rust-fixed-regex-in-loop
title: rust-fixed-regex-in-loop
description: "A Rust Regex with a fixed pattern is compiled inside a loop."
checker: performance
group: "Polyglot source checks"
impact: medium
fixable: manual
---

## What it flags

A Rust Regex with a fixed pattern is compiled inside a loop.

## Example

`Regex::new("pattern")`

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "rust-fixed-regex-in-loop": "off" }
}
```
