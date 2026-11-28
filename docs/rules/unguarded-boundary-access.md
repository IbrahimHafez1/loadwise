---
id: unguarded-boundary-access
title: unguarded-boundary-access
description: "A nested property is read from outside input or a lookup that can be missing, so absent data throws a TypeError."
checker: reliability
group: "Source rules"
impact: medium
fixable: inline
---

## What it flags

A nested read such as `req.body.user.email`, `JSON.parse(text).a.b` or `response.data.x.y` on untyped input, or on a `find()` / `Map#get` result in files without `strictNullChecks`, throws a TypeError when the value is missing. Reads under optional chaining, a guard (including `map.has(key)` before `map.get(key)`), an early return, an `assert`/`invariant` call or a `try` are accepted; typed values are left to the compiler. The fix adds optional chaining and is marked for review: add a default or answer with a 400, or validate the input first.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "unguarded-boundary-access": "off" }
}
```
