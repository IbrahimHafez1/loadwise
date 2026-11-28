---
id: express-cookie-auth-missing-csrf
title: express-cookie-auth-missing-csrf
description: "Cookie-based session or auth is paired with state-changing routes without CSRF protection or `sameSite: \"strict\"`."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

Cookie-based session or auth is paired with state-changing routes without CSRF protection or `sameSite: "strict"`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "express-cookie-auth-missing-csrf": "off" }
}
```
