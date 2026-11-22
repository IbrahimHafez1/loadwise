'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { modulePathOf } = require('./call-syntax.cjs');
const { findRepeatOwner } = require('./repeated.cjs');
const { isSequentialByDesign, iteratesArrayLiteral } = require('./sequential-loops.cjs');

const RULE_ID = 'notification-send-in-loop';
const AWS_PACKAGES = ['@aws-sdk/', '@smithy/', 'aws-sdk/'];
const AWS_SNS_COMMANDS = new Set(['PublishCommand']);
const AWS_SES_COMMANDS = new Set(['SendEmailCommand', 'SendTemplatedEmailCommand']);
const TWILIO_MESSAGE_FILE = /^twilio\/.*\/message\.d\.ts$/;
// Only project functions named like a sender are searched for a wrapped provider call, which keeps the scan of every
// call inside a loop cheap.
const WRAPPER_NAME = /send|notif|push|mail|publish|message/i;
const PERSONALISATION_NOTE =
  'If each recipient needs different content, build one message per recipient and send them in a single batch call: batch APIs take a per-message payload.';

// `level` is 'default' when the provider documents a batch call that fits the loop, and 'contextual' when the batch
// shape depends on whether the content is identical or the provider only offers connection reuse.
const PROVIDERS = [
  {
    label: 'firebase-admin messaging',
    packages: ['firebase-admin/'],
    methods: new Set(['send', 'sendToDevice']),
    batch: '`messaging().sendEach(messages)` (up to 500 per call) or `sendEachForMulticast({ tokens, ... })`',
    level: 'default',
  },
  {
    label: '@sendgrid/mail',
    packages: ['@sendgrid/mail/'],
    methods: new Set(['send']),
    batch: '`sgMail.send(messages)` with an array, or one message with `personalizations`',
    level: 'default',
  },
  {
    label: 'expo-server-sdk',
    packages: ['expo-server-sdk/'],
    methods: new Set(['sendPushNotificationsAsync']),
    batch: '`expo.chunkPushNotifications(messages)` and one `sendPushNotificationsAsync(chunk)` per chunk of 100',
    level: 'default',
  },
  {
    label: 'OneSignal',
    packages: ['onesignal-node/', '@onesignal/node-onesignal/'],
    methods: new Set(['createNotification']),
    batch: 'one notification that targets a list of recipients (`include_player_ids` or `include_subscription_ids`)',
    level: 'default',
  },
  {
    label: 'AWS SNS publish',
    packages: AWS_PACKAGES,
    methods: new Set(['send', 'publish']),
    commands: AWS_SNS_COMMANDS,
    clientFile: /^aws-sdk\/clients\/sns\.d\.ts$/,
    batch: '`PublishBatchCommand` (up to 10 messages per call)',
    level: 'default',
  },
  {
    label: 'AWS SES send',
    packages: AWS_PACKAGES,
    methods: new Set(['send', 'sendEmail', 'sendTemplatedEmail']),
    commands: AWS_SES_COMMANDS,
    clientFile: /^aws-sdk\/clients\/ses\.d\.ts$/,
    batch:
      '`SendBulkEmailCommand` / `sendBulkTemplatedEmail` (up to 50 destinations per call), or one message with several recipients when the content is identical',
    level: 'contextual',
  },
  {
    label: 'nodemailer sendMail',
    packages: ['nodemailer/', '@types/nodemailer/'],
    methods: new Set(['sendMail']),
    batch:
      'one message with several recipients when the content is identical, or a pooled transport (`pool: true`) so the SMTP connection is reused',
    level: 'contextual',
  },
  {
    label: 'web-push sendNotification',
    packages: ['web-push/', '@types/web-push/'],
    methods: new Set(['sendNotification']),
    batch:
      'no batch call exists; send the payload to the subscriptions with bounded concurrency instead of one at a time',
    level: 'contextual',
  },
  {
    label: 'Twilio messages.create',
    packages: ['twilio/'],
    methods: new Set(['create']),
    file: TWILIO_MESSAGE_FILE,
    batch: 'the Twilio Notify API (one request with a list of bindings), or bounded concurrency',
    level: 'contextual',
  },
];

function calledName(callee) {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isIdentifier(callee)) return callee.text;
}

function argumentTypeName(call, context) {
  const [argument] = call.arguments;
  return argument && context.checker.getTypeAtLocation(argument).getSymbol()?.name;
}

function matchesProvider(provider, call, name, modulePath, context) {
  if (!provider.methods.has(name) || !provider.packages.some((prefix) => modulePath.startsWith(prefix))) return false;
  if (provider.file && !provider.file.test(modulePath)) return false;
  if (!provider.commands) return true;
  // AWS SDK v3 sends every command through one generic `send`, so the command class names the service; v2 has one client file per service.
  if (name === 'send') return provider.commands.has(argumentTypeName(call, context));
  return provider.clientFile.test(modulePath);
}

function providerOf(call, context) {
  const name = calledName(ts.skipOuterExpressions(call.expression));
  if (!name) return;
  const declaration = context.checker.getResolvedSignature(call)?.declaration;
  const modulePath = declaration && modulePathOf(declaration);
  if (!modulePath) return;
  return PROVIDERS.find((provider) => matchesProvider(provider, call, name, modulePath, context));
}

// Per declaration: the provider call a project wrapper makes once per call, if any.
const wrappedSends = new WeakMap();

function wrappedProviderCall(call, context) {
  const name = calledName(ts.skipOuterExpressions(call.expression));
  if (!name || !WRAPPER_NAME.test(name)) return;
  const declaration = context.checker.getResolvedSignature(call)?.declaration;
  if (!declaration || !ts.isFunctionLike(declaration) || !declaration.body) return;
  if (declaration.getSourceFile().isDeclarationFile || modulePathOf(declaration)) return;
  if (!wrappedSends.has(declaration)) {
    let found;
    (function visit(node) {
      if (found || (node !== declaration.body && ts.isFunctionLike(node))) return;
      const provider = ts.isCallExpression(node) && providerOf(node, context);
      if (provider && !findRepeatOwner(node, context.checker)) found = { call: node, provider };
      else ts.forEachChild(node, visit);
    })(declaration.body);
    wrappedSends.set(declaration, found);
  }
  return wrappedSends.get(declaration);
}

function directMessage(provider, callee) {
  return `\`${callee.getText()}()\` sends one ${provider.label} message per item, so every recipient pays its own network round trip and counts against the provider's rate limit separately. Use ${provider.batch}. ${PERSONALISATION_NOTE}`;
}

function wrappedMessage(provider, callee) {
  return `\`${callee.getText()}()\` sends one ${provider.label} message per item through a project helper, so every recipient pays its own network round trip. Add a variant that takes all the recipients and uses ${provider.batch}. ${PERSONALISATION_NOTE}`;
}

function contextualReason(provider) {
  return `${provider.label} has no batch call that always fits: whether one request can replace the loop depends on whether the messages are identical, and a provider rate limit or per-recipient failure handling may make a loop intentional.`;
}

function check(node, context) {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) && !ts.isIdentifier(callee)) return;
  if (!context.isRepeated(node)) return;
  const direct = providerOf(node, context);
  const wrapped = !direct && wrappedProviderCall(node, context);
  const provider = direct ?? wrapped?.provider;
  if (!provider) return;
  const owner = findRepeatOwner(node, context.checker);
  if (!owner || isSequentialByDesign(node, owner) || iteratesArrayLiteral(owner)) return;
  const message = direct ? directMessage(provider, callee) : wrappedMessage(provider, callee);
  const reportNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  context.report(
    reportNode,
    RULE_ID,
    message,
    provider.level === 'contextual' ? contextualReason(provider) : undefined,
  );
}

module.exports = { check };
