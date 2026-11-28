---
id: java-jdbc-query-in-loop
title: java-jdbc-query-in-loop
description: "A JDBC query executes inside a Java loop instead of batching."
checker: performance
group: "Polyglot source checks"
impact: high
fixable: manual
---

## What it flags

A JDBC query executes inside a Java loop instead of batching.

## Example

A JDBC query executes inside a Java loop instead of batching.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "java-jdbc-query-in-loop": "off" }
}
```
