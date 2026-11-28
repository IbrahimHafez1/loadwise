---
id: http-call-without-timeout
title: http-call-without-timeout
description: "A fetch or axios call has no timeout or abort signal."
checker: reliability
group: "Source rules"
impact: high
fixable: inline
---

## What it flags

A `fetch` or axios call has no `signal` or `timeout`, so a hung upstream holds the request.

## How to review or fix

Set a timeout or an abort signal.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "http-call-without-timeout": "off" }
}
```
