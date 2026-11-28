---
id: angular-bypass-security-trust
title: angular-bypass-security-trust
description: "DomSanitizer.bypassSecurityTrust* is called on a dynamic value, which turns off Angular's built-in sanitization."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

DomSanitizer.bypassSecurityTrust* is called on a dynamic value, which turns off Angular's built-in sanitization.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "angular-bypass-security-trust": "off" }
}
```
