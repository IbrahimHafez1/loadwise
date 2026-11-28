---
id: zip-slip-extraction
title: zip-slip-extraction
description: "An archive entry controls an extraction path without a recognized containment check."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

An archive entry name (adm-zip, yauzl, unzipper, tar-stream, jszip, node-stream-zip) reaches a file write without a prior containment check. The trace follows aliases, destructuring and local call hops.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "zip-slip-extraction": "off" }
}
```
