---
id: jwt-verify-without-algorithms
title: jwt-verify-without-algorithms
description: "JWT verification does not restrict the accepted signing algorithms."
checker: security
group: "Rules"
impact: high
fixable: inline
---

## What it flags

`jsonwebtoken` `verify` without `algorithms` in a literal options object. Public keys, key files and key-lookup callbacks are default; shared secrets are contextual. The fix pins the algorithm the same key signs with in the file.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "jwt-verify-without-algorithms": "off" }
}
```
