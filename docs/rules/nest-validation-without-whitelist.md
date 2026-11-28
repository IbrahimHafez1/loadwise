---
id: nest-validation-without-whitelist
title: nest-validation-without-whitelist
description: "A NestJS ValidationPipe permits properties outside the validated DTO."
checker: security
group: "Rules"
impact: medium
fixable: inline
---

## What it flags

A NestJS `ValidationPipe` is created without `whitelist: true`, so undeclared properties reach handlers. Without `forbidNonWhitelisted` it is contextual.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "nest-validation-without-whitelist": "off" }
}
```
