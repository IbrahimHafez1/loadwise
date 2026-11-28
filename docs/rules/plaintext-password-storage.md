---
id: plaintext-password-storage
title: plaintext-password-storage
description: "A password is stored or written without being hashed."
checker: security
group: "Rules"
impact: critical
fixable: manual
---

## What it flags

A request password is written by an ORM create, update or save, or a raw INSERT or UPDATE, without being hashed. A value named like a hash or digest, and a model hook that hashes on save, keep it quiet.

## How to review or fix

Hash it with `argon2`, `bcrypt` or `crypto.scrypt` first.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "plaintext-password-storage": "off" }
}
```
