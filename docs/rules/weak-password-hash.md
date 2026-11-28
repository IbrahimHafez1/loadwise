---
id: weak-password-hash
title: weak-password-hash
description: "A password is hashed with an algorithm unsuitable for password storage."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

`createHash` with md5, sha1, sha256 or sha512 (or the crypto-js or md5 package) hashes a password or the digest is stored as one.

## How to review or fix

Use `argon2`, `bcrypt` or `crypto.scrypt`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "weak-password-hash": "off" }
}
```
