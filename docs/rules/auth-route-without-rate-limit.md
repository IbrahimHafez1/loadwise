---
id: auth-route-without-rate-limit
title: auth-route-without-rate-limit
description: "A login, signup or password-reset route has no rate limiter."
checker: security
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

A login, signup, password-reset or OTP route has no rate limiter, which allows brute force and credential stuffing. A route is contextual when a limiter package is imported in a module connected to its file by imports (the file itself, one it imports, or app setup that imports it) but not tied to the route; dismiss a gateway or proxy limit with a review comment.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "auth-route-without-rate-limit": "off" }
}
```
