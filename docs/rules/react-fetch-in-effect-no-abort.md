---
id: react-fetch-in-effect-no-abort
title: react-fetch-in-effect-no-abort
description: "A fetch in an effect has no AbortController or cleanup, so dependency changes can race and apply stale results."
checker: performance
group: "Source checks"
impact: low
fixable: manual
---

## What it flags

A fetch in an effect has no AbortController or cleanup, so dependency changes can race and apply stale results.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "react-fetch-in-effect-no-abort": "off" }
}
```
