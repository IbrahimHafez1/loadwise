---
id: rust-unwrap-in-production
title: rust-unwrap-in-production
description: "Rust code outside tests calls unwrap(), turning an Err or None into a panic."
checker: reliability
group: "Source rules"
impact: medium
fixable: manual
---

## What it flags

`.unwrap()` in non-test code panics on `None` or `Err`.

## How to review or fix

Test modules, `static`/`const` items and lock guards are accepted. Handle the case or use `expect` with the invariant that makes it safe.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "rust-unwrap-in-production": "off" }
}
```
