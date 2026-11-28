---
id: upload-without-size-limit
title: upload-without-size-limit
description: "A multer or Nest upload interceptor has no file size limit."
checker: reliability
group: "Source rules"
impact: high
fixable: inline
---

## What it flags

A multer or Nest upload interceptor has no `limits.fileSize`, so one large upload can exhaust memory. A global `MulterModule.register({ limits })` set elsewhere is not visible to the check.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "upload-without-size-limit": "off" }
}
```
