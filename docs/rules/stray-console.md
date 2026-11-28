---
id: stray-console
title: stray-console
description: "A console call in production code bypasses the logger, so its output has no level or structure."
checker: maintainability
group: "What gets checked"
impact: low
fixable: inline
---

## What it flags

A `console.*` call in server or Node code, as the execution context classifies it, writes unleveled, unstructured output. Browser and frontend files, CLI scripts (a shebang or `process.argv`), vendored or bundled libraries, stories, playgrounds, docs, examples and fixtures, calls under an eslint-disable comment for `no-console`, and a call directly followed by `process.exit` or `throw` are skipped, as are tests, configuration, seeds, migrations, logger implementations, development-only guards, last-resort `uncaughtException` handlers and error boundaries. When the file already has a `logger` (or a Nest `this.logger`), the fix routes the call through it and is marked for review.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "stray-console": "off" }
}
```
