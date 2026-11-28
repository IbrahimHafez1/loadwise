---
id: jwt-sign-without-expiry
title: jwt-sign-without-expiry
description: "A signed JWT has no explicit expiration."
checker: security
group: "Rules"
impact: medium
fixable: inline
---

## What it flags

`jsonwebtoken` `sign` with a literal payload and no `expiresIn` option or `exp` claim. Literal NestJS JwtService signing also uses expiry set by its bound JwtModule registration. Unresolved defaults are contextual.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "jwt-sign-without-expiry": "off" }
}
```
