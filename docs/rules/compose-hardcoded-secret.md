---
id: compose-hardcoded-secret
title: compose-hardcoded-secret
description: "A Docker Compose service supplies a secret as a literal environment value."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

A docker-compose `environment:` entry sets a secret-looking key to a literal value instead of a substitution or secret.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "compose-hardcoded-secret": "off" }
}
```
