---
id: password-hash-sync-in-async
title: password-hash-sync-in-async
description: "A synchronous bcrypt call blocks the event loop inside an async function."
checker: performance
group: "Source checks"
impact: high
fixable: inline
---

## What it flags

`hashSync`, `compareSync` or `genSaltSync` from bcrypt or bcryptjs in an async function blocks the event loop for the whole hash.

## How to review or fix

Use the promise form.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "password-hash-sync-in-async": "off" }
}
```
