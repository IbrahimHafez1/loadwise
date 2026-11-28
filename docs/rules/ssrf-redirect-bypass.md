---
id: ssrf-redirect-bypass
title: ssrf-redirect-bypass
description: "An outbound HTTP request with a dynamic URL does not disable redirects, allowing SSRF allowlist bypasses."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

An outbound HTTP request with a dynamic URL does not disable redirects (`redirect: 'error'` / `'manual'` or `maxRedirects: 0`), allowing SSRF allowlist bypasses.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "ssrf-redirect-bypass": "off" }
}
```
