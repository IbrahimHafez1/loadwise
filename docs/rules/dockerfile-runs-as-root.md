---
id: dockerfile-runs-as-root
title: dockerfile-runs-as-root
description: "The final image selects root or inherits an unverified base-image user."
checker: security
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

The final stage has no `USER` instruction, or its last `USER` is root. Builder stages are not checked.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "dockerfile-runs-as-root": "off" }
}
```
