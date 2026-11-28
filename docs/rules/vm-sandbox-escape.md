---
id: vm-sandbox-escape
title: vm-sandbox-escape
description: "Node `vm` or `vm2` executes dynamic code or an untrusted context, risking sandbox escape and host RCE."
checker: security
group: "Rules"
impact: critical
fixable: manual
---

## What it flags

Node `vm` or `vm2` executes dynamic code or an untrusted context, risking sandbox escape and host RCE.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "vm-sandbox-escape": "off" }
}
```
