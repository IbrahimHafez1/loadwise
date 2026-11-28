---
id: ts-suppression-without-reason
title: ts-suppression-without-reason
description: "A @ts-ignore, @ts-expect-error or @ts-nocheck directive has no explanation."
checker: maintainability
group: "What gets checked"
impact: low
fixable: manual
---

## What it flags

`@ts-ignore`, `@ts-expect-error` or `@ts-nocheck` with no explanatory text after the directive. Text after the directive counts as the reason. Declaration files, fixtures, docs, examples, generated and vendored code are skipped.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "ts-suppression-without-reason": "off" }
}
```
