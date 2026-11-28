---
id: password-hash-pure-js
title: password-hash-pure-js
description: "bcryptjs hashes passwords in pure JavaScript on the main thread."
checker: performance
group: "Source checks"
impact: medium
fixable: inline
---

## What it flags

`bcryptjs` hashes in pure JavaScript and costs tens to hundreds of milliseconds of main-thread CPU per call.

## How to review or fix

Use native `bcrypt`, `@node-rs/bcrypt` or `argon2`. Reported once per file; test files are skipped.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "password-hash-pure-js": "off" }
}
```
