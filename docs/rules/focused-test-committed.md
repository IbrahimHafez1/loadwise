---
id: focused-test-committed
title: focused-test-committed
description: "A committed .only, fit or fdescribe makes the test runner skip every other test."
checker: maintainability
group: "What gets checked"
impact: medium
fixable: manual
---

## What it flags

`.only` on `describe`, `it`, `test` or `suite` (including `test.describe.only` and `.only.each`), and Jasmine `fit` and `fdescribe`, in a test file. The runner skips every other test, so CI stays green while most of the suite never runs. Fixtures, docs, examples and vendored code are skipped.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "focused-test-committed": "off" }
}
```
