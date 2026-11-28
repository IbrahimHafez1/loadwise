---
id: error-rethrown-without-cause
title: error-rethrown-without-cause
description: "A catch block throws a new error without the caught one, so the original message and stack are lost."
checker: reliability
group: "Source rules"
impact: low
fixable: manual
---

## What it flags

A `catch (err)` block throws `new SomeError(...)` while the block never mentions `err`, so the original message and stack are lost.

## How to review or fix

Pass `{ cause: err }`. Only a block whose single statement throws a built-in `Error` class counts. A block that uses the caught value anywhere or does anything else first (such as reporting to the user), a `catch` without a binding or with an `_` name, and domain or HTTP errors (`AppError`, Nest `*Exception`) are skipped. Fixture, e2e, test-helper and migration folders are skipped too.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "error-rethrown-without-cause": "off" }
}
```
