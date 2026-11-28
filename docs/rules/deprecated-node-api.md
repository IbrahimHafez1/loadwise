---
id: deprecated-node-api
title: deprecated-node-api
description: "A deprecated Node.js API is used: new Buffer(), url.parse() or fs.exists()."
checker: maintainability
group: "What gets checked"
impact: medium
fixable: inline
---

## What it flags

`new Buffer()` (use `Buffer.alloc` or `Buffer.from`), `url.parse()` (use `new URL()`) or `fs.exists()` (use `fs.access` or `existsSync`). The `Buffer` fix applies to literal arguments; the `url.parse` fix is marked for review because relative input throws and the result has no `path`, `auth` or `query`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "deprecated-node-api": "off" }
}
```
