---
id: retry-without-backoff
title: retry-without-backoff
description: "A retry loop calls the network again with no delay between attempts."
checker: reliability
group: "Source rules"
impact: medium
fixable: inline
---

## What it flags

A network call is retried in a loop, or axios-retry is set up, with no wait between attempts.

## How to review or fix

Add exponential backoff with jitter. axios-retry without `retryDelay` is contextual.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "retry-without-backoff": "off" }
}
```
