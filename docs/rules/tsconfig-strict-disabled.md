---
id: tsconfig-strict-disabled
title: tsconfig-strict-disabled
description: "A tsconfig turns off strict type checking."
checker: maintainability
group: "What gets checked"
impact: medium
fixable: manual
---

## What it flags

A `tsconfig*.json` with `"strict": false`, or with no `strict` while `compilerOptions` set `strictNullChecks` or `noImplicitAny` to `false`. Configs for tests (`tsconfig.test.json`, `tsconfig.spec.json`, files under test folders), templates, fixtures and examples are skipped.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "tsconfig-strict-disabled": "off" }
}
```
