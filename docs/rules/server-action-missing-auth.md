---
id: server-action-missing-auth
title: server-action-missing-auth
description: "An exported Next.js Server Action performs work without verifying authentication or session state."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

An exported Next.js Server Action performs work without verifying authentication or session state.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "server-action-missing-auth": "off" }
}
```
