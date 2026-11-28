---
id: discarded-error-result
title: discarded-error-result
description: "A call discards a typed Either or Result that can carry a failure as a value."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

A call discards a typed `fp-ts` `Either` or `neverthrow` `Result`. This includes async calls, standalone `await` and explicit `void`.

## How to review or fix

Check the failure branch or return the result to a caller that handles it.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "discarded-error-result": "off" }
}
```
