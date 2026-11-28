---
id: storage-object-public-acl
title: storage-object-public-acl
description: "A storage upload makes the object publicly readable."
checker: security
group: "Rules"
impact: high
fixable: manual
---

## What it flags

An S3 or Google Cloud Storage upload sets a public-read ACL, so anyone can read the object.

## How to review or fix

Keep objects private and hand out short-lived presigned URLs. Keys or buckets named like public assets are contextual; a public read-write ACL never is.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "storage-object-public-acl": "off" }
}
```
