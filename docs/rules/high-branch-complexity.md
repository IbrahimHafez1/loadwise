---
id: high-branch-complexity
title: high-branch-complexity
description: "A function reaches a branch complexity score of 15."
checker: maintainability
group: "What gets checked"
impact: medium
fixable: inline
---

## What it flags

A JS/TS function reaches a score of 15.

## How to review or fix

Start at one and count each conditional, loop, switch, catch or ternary. A flat switch contributes one decision. When most of a function's decisions are plain bail-outs (an `if` with no `else` that only returns, throws, continues or breaks, at the top of the body), up to twelve of them count half toward the 15, so a long run of independent guards is not reported on its own. The reported score is still the plain count.

## Inline fix

Combines nested conditional expressions with the same literal success label while preserving short-circuit order. Other fixes merge nested `if`s, join adjacent same-exit `if`s with `||`, turn `x ? true : false` into `Boolean(x)`, and `if (!x) x = value` into `x ||= value`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "high-branch-complexity": "off" }
}
```
