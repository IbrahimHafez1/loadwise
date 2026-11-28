---
id: insecure-random-for-secret
title: insecure-random-for-secret
description: "A sensitive token or secret uses a non-cryptographic random source."
checker: security
group: "Rules"
impact: high
fixable: inline
---

## What it flags

`Math.random()` feeds a token, code, nonce, session or secret.

## How to review or fix

Use `crypto.randomBytes`, `randomInt` or `randomUUID`; names that only end in `id` are contextual. `Math.floor(Math.random() * N)` has a source fix.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "insecure-random-for-secret": "off" }
}
```
