---
id: hardcoded-secret
title: hardcoded-secret
description: "The source supplies a literal credential or cryptographic secret."
checker: security
group: "Rules"
impact: critical
fixable: manual
---

## What it flags

A known credential shape (`sk_live_`, `AKIA...`, `ghp_`, private keys), a string literal used as a JWT, HMAC or session signing key, or a high-entropy value assigned to a secret-named variable or property. Placeholders, documentation examples and test sources are skipped; low-entropy named values are contextual.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "hardcoded-secret": "off" }
}
```
