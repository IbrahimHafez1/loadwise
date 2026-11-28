---
id: path-traversal
title: path-traversal
description: "Request data controls a filesystem path without a recognized containment check."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

A file path built from request data reaches `fs`, `res.sendFile` without `root`, `res.download` or `res.render`. `path.basename` and a containment check clear it. An anchored filename allowlist also clears it when the checker can prove the allowed characters and the validated value reaches the file operation unchanged.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "path-traversal": "off" }
}
```
