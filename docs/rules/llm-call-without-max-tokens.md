---
id: llm-call-without-max-tokens
title: llm-call-without-max-tokens
description: "An OpenAI chat or responses call sets no output token limit."
checker: performance
group: "Source checks"
impact: medium
fixable: manual
---

## What it flags

An OpenAI `chat.completions.create` or `responses.create` call passes an options object with no `max_tokens`, `max_completion_tokens` or `max_output_tokens`, so the output length is unbounded. Calls with a spread or non-literal options are skipped. Anthropic `messages.create` is not checked because its types require `max_tokens`.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "llm-call-without-max-tokens": "off" }
}
```
