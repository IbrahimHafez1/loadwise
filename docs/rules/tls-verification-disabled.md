---
id: tls-verification-disabled
title: tls-verification-disabled
description: "A TLS client skips certificate or server hostname verification."
checker: security
group: "Rules"
impact: high
fixable: inline
---

## What it flags

A literal `rejectUnauthorized: false`, `strictSSL: false` or `NODE_TLS_REJECT_UNAUTHORIZED = '0'`. Under a non-production guard it is contextual; database `ssl` options count too.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "tls-verification-disabled": "off" }
}
```
