---
id: ssrf-request-url
title: ssrf-request-url
description: "Request data controls the destination of a server-side network request."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

An outgoing HTTP request whose URL or host comes from request data. A fixed origin with a request path, an enforced exact host allowlist on the parsed URL, or an SSRF-filtering agent is quiet.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "ssrf-request-url": "off" }
}
```
