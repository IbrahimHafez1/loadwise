---
id: go-error-discarded
title: go-error-discarded
description: "A Go error result is assigned to the blank identifier and never checked."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

An error result is dropped with `_`: `value, _ := f()` for calls known to return `(T, error)` (the `os`, `io`, `strconv`, `json`, `sql` and `net` packages, `http.Get`, `url.Parse`, `time.Parse`, and methods such as `Marshal`, `ReadAll`, `Atoi`, `Query`, `Decode`), or `_ = w.Write(...)` and similar write, flush, sync, encode, exec and commit calls. Calls whose second result is a bool, such as `os.LookupEnv`, `cache.Get` or `q.Pop()`, and explicit `_ = x.Close()` or `_ = tx.Rollback()` are accepted.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "go-error-discarded": "off" }
}
```
