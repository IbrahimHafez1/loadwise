---
id: csharp-async-void
title: csharp-async-void
description: "An async void method cannot be awaited and can crash the process on unhandled exceptions."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

An `async void` method cannot be awaited and can crash the process on unhandled exceptions. Event handlers (`object sender, …EventArgs e`) and `override` methods, which cannot change their return type, are accepted.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "csharp-async-void": "off" }
}
```
