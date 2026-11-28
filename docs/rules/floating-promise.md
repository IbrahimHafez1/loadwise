---
id: floating-promise
title: floating-promise
description: "A promise-returning call is neither awaited, returned nor handled, so its failure goes unseen."
checker: reliability
group: "Source rules"
impact: high
fixable: inline
---

## What it flags

A promise-returning call is a bare statement in an async function or request handler, or `array.forEach(async ...)` runs awaits nobody waits for. Returning, awaiting, using `void`, or attaching a rejection callback suppresses the bare-call warning. Omitted or nullish callbacks do not handle rejections.

## How to review or fix

Test files and helpers listed under `fireAndForget` in the policy are skipped.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "floating-promise": "off" }
}
```
