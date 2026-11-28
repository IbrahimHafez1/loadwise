---
id: external-call-in-transaction
title: external-call-in-transaction
description: "An external call is awaited inside a database transaction, holding its connection and locks."
checker: performance
group: "Source checks"
impact: high
fixable: inline
---

## What it flags

An external call is awaited inside a database transaction callback, holding the connection and locks until it returns.

## How to review or fix

Move it before the transaction or after commit; side effects cannot roll back.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "external-call-in-transaction": "off" }
}
```
