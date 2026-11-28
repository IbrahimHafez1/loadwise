---
id: express-missing-helmet
title: express-missing-helmet
description: "The Express or NestJS server starts without helmet security headers middleware (contextual: a proxy may set them)."
checker: security
group: "Rules"
impact: low
fixable: manual
---

## What it flags

The Express or NestJS server starts without helmet security headers middleware (contextual: a proxy may set them).

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "express-missing-helmet": "off" }
}
```
