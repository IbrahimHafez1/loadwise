---
id: swallowed-error
title: swallowed-error
description: "A catch block drops the error and the code after the try carries on as if it succeeded."
checker: reliability
group: "Source rules"
impact: medium
fixable: manual
---

## What it flags

A JS/TS `catch` block in non-test code is empty, or only calls `console.*`, `logger.*` or `this.logger.*` while the code after the `try` carries on as if it had succeeded. A comment inside the block, an optional `require()` or `import()` probe, a cleanup in a `finally` or `catch` block, and a `try` made only of `close`, `destroy`, `release`-style calls are accepted. A catch that rethrows, returns or records a failure is not reported.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "swallowed-error": "off" }
}
```
