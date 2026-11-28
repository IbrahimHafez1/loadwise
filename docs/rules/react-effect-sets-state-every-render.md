---
id: react-effect-sets-state-every-render
title: react-effect-sets-state-every-render
description: "An effect with no dependency array sets state to a new value on every run, so the component re-renders forever."
checker: reliability
group: "Source rules"
impact: high
fixable: manual
---

## What it flags

A `useEffect` or `useLayoutEffect` with no dependency array sets state to a new object, array or computed value on every run, so the component re-renders without end. Setting a constant such as `true` is not reported, because React bails out when the value is unchanged.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "react-effect-sets-state-every-render": "off" }
}
```
