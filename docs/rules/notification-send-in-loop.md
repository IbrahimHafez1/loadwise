---
id: notification-send-in-loop
title: notification-send-in-loop
description: "A push, email or Firebase message is sent once per loop iteration instead of in one batch."
checker: performance
group: "Source checks"
impact: high
fixable: inline
---

## What it flags

A firebase-admin, SendGrid, Expo, OneSignal or SNS send runs once per loop item where the provider has a batch API. nodemailer, web-push, Twilio and SES sends are contextual because their batch shape depends on the content. Providers are recognised from their types.

## Configuration

Set the rule to `"off"` in `loadwise.config.json` to drop its findings:

```json
{
  "rules": { "notification-send-in-loop": "off" }
}
```
