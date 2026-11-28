---
id: password-hash-in-response
title: password-hash-in-response
description: "A response returns a user record that still holds its password hash."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

A request handler sends a user record read without a field selection, so its password hash reaches the client. Select or omit the field, or hide it on the model with `select: false`. `@Exclude()` hides it only when the response goes through a class-transformer conversion (`instanceToPlain` or `ClassSerializerInterceptor`); an instance sent directly as JSON still includes the hash.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "password-hash-in-response": "off" }
}
```
