---
id: jwt-decode-for-auth
title: jwt-decode-for-auth
description: "Authentication uses decoded JWT claims without verifying the token signature."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

`decode` (`jsonwebtoken`, `JwtService`, the jwt-decode package) has no `verify` on the same token and its result becomes `req.user`, is used in a guard or auth middleware, or filters a query. Other uses are contextual.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "jwt-decode-for-auth": "off" }
}
```
