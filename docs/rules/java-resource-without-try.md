---
id: java-resource-without-try
title: java-resource-without-try
description: "A Java stream, reader or connection is opened outside try-with-resources, so an exception leaks it."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

A stream, reader, writer or JDBC connection is opened outside try-with-resources and not closed by a later `try`/`finally`, returned or stored, so an exception leaks it.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "java-resource-without-try": "off" }
}
```
