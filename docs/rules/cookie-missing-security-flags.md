---
id: cookie-missing-security-flags
title: cookie-missing-security-flags
description: "A sensitive cookie is set without the expected security attributes."
checker: security
group: "Rules"
impact: high
fixable: inline
---

## What it flags

A session, token or auth cookie is set without `httpOnly`, or with `secure: false`. A missing `secure` or `sameSite` is contextual. Non-literal options are not judged.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "cookie-missing-security-flags": "off" }
}
```
