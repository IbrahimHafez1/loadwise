---
id: jwt-weak-secret-literal
title: jwt-weak-secret-literal
description: "JWT signing or verification uses a short (< 32 chars) or weak literal secret susceptible to brute-force forgery."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

JWT signing or verification uses a short (\< 32 chars) or weak literal secret susceptible to brute-force forgery.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "jwt-weak-secret-literal": "off" }
}
```
