---
id: insecure-cipher
title: insecure-cipher
description: "A cryptographic operation selects an insecure cipher or mode."
checker: security
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

`createCipher` or `createDecipher` (no IV), DES, RC2, RC4 or Blowfish algorithms, ECB mode, or a fixed string or `Buffer.alloc` IV in `createCipheriv`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "insecure-cipher": "off" }
}
```
