---
id: secret-compared-non-constant-time
title: secret-compared-non-constant-time
description: "A secret is compared with an operation that can vary in timing with its contents."
checker: security
group: "Rules"
impact: medium
fixable: inline
---

## What it flags

An HMAC or hash digest, or a value named like a signature, secret, token, OTP, password or CSRF token, is compared directly with request input. For strict comparisons of two proven strings in a Node module, the fix uses `crypto.timingSafeEqual` and preserves JavaScript string equality.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "secret-compared-non-constant-time": "off" }
}
```
