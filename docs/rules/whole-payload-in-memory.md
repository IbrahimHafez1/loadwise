---
id: whole-payload-in-memory
title: whole-payload-in-memory
description: "An operation loads an entire file, stream, or response into memory."
checker: performance
group: "Source checks"
impact: medium
fixable: manual
---

## What it flags

A handler reads a request-chosen path with `fs.readFile`, or a download or stream is buffered whole only to be written out.

## How to review or fix

Stream it with `pipeline`. The `Response` check needs fetch types.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "whole-payload-in-memory": "off" }
}
```
