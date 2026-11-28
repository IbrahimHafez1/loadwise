---
id: upload-client-filename
title: upload-client-filename
description: "A file upload is stored under the original name supplied by the client."
checker: security
group: "Rules"
impact: medium
fixable: manual
---

## What it flags

multer disk storage saves uploads under the client's file name, so same-named uploads overwrite each other and the client picks the extension.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "upload-client-filename": "off" }
}
```
