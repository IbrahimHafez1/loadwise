---
id: cors-credentials-any-origin
title: cors-credentials-any-origin
description: "A credentialed CORS response allows arbitrary origins."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

CORS options allow credentials with origin `*`, `true`, a match-everything regex or a callback that always accepts. Listed or configured origins are clean.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "cors-credentials-any-origin": "off" }
}
```
