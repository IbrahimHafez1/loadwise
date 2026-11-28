---
id: nosql-operator-injection
title: nosql-operator-injection
description: "Request data can introduce query operators into a NoSQL filter."
checker: security
group: "Rules"
impact: high
fixable: inline
---

## What it flags

Request data that can arrive as an object is a Mongoose or MongoDB filter, a filter value or a `$where` expression. Contextual when applicable Express sanitizer registration is visible.

## How to review or fix

Fix: wrap the value in `$eq`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "nosql-operator-injection": "off" }
}
```
