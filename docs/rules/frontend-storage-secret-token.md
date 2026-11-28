---
id: frontend-storage-secret-token
title: frontend-storage-secret-token
description: "A token, JWT, password or API key is stored in localStorage or sessionStorage, readable by any script on the page."
checker: security
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

A token, JWT, password or API key is stored in localStorage or sessionStorage, readable by any script on the page.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "frontend-storage-secret-token": "off" }
}
```
